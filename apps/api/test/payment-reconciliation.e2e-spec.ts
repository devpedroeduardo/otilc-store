import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import type { OrderStatus } from '@otilc/shared';
import { AdminOrdersService } from '../src/admin-orders/admin-orders.service';
import { ENV, type Env } from '../src/config/env';
import { createDatabase } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { orders, paymentAlerts, payments, products, variants } from '../src/db/schema';
import { OrderExpirationService } from '../src/orders/order-expiration.service';
import { OrdersService } from '../src/orders/orders.service';
import {
  PIX_PROVIDER,
  PixProviderError,
  type MercadoPagoClient,
  type ProviderPayment,
} from '../src/payments/mercadopago.client';
import {
  LEGACY_ID_PAUSE_HOURS,
  PaymentReconciliationService,
  RECONCILIATION_BATCH,
} from '../src/payments/payment-reconciliation.service';
import { PaymentTransitionService } from '../src/payments/payment-transition.service';
import {
  RECONCILIATION_MAX_FAILURES,
  reconciliationDelayMs,
} from '../src/payments/reconciliation-backoff';
import {
  fakeOrderId,
  mockMercadoPago,
  mpStatus,
  notCancellable,
  setupPixTestApp,
  signature,
  type MercadoPagoMock,
} from './pix-setup';
import { resetData, teardownTestApp, TEST_DATABASE_URL, type TestContext } from './setup';

const customer = { name: 'Bia Lima', email: 'bia@example.com', phone: '+5585999990001' };

describe('Conciliação do Pix e cancelamento no Mercado Pago (integração, provedor simulado)', () => {
  let ctx: TestContext;
  let client: MercadoPagoClient;
  let mp: MercadoPagoMock;
  let reconciliation: PaymentReconciliationService;
  let warn: jest.SpyInstance;
  let ipCounter = 0;
  const nextIp = () => `10.70.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await setupPixTestApp();
    client = ctx.app.get<MercadoPagoClient>(PIX_PROVIDER);
    reconciliation = ctx.app.get(PaymentReconciliationService);
  });
  beforeEach(async () => {
    await resetData(ctx.db);
    await ctx.db.execute(sql`TRUNCATE payment_notifications`);
    mp = mockMercadoPago(client);
    warn = jest.spyOn(Logger.prototype, 'warn');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => teardownTestApp(ctx));

  const http = () => request(ctx.app.getHttpServer());

  async function variantWithStock(slug: string, stock: number) {
    const product = await ctx.db.query.products.findFirst({
      where: eq(products.slug, slug),
      with: { variants: true },
    });
    if (!product) throw new Error(`produto ${slug} ausente na seed`);
    const [v] = product.variants;
    await ctx.db.update(variants).set({ stock }).where(eq(variants.id, v.id));
    return v;
  }

  async function stockOf(id: string) {
    const [row] = await ctx.db
      .select({ stock: variants.stock, reserved: variants.reserved })
      .from(variants)
      .where(eq(variants.id, id));
    return row;
  }

  async function orderStatus(id: string): Promise<OrderStatus> {
    const [row] = await ctx.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, id));
    return row.status;
  }

  async function paymentOf(orderId: string) {
    const rows = await ctx.db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function alertsOf(orderId: string) {
    const rows = await ctx.db
      .select({ alert: paymentAlerts.alert })
      .from(paymentAlerts)
      .innerJoin(payments, eq(payments.id, paymentAlerts.paymentId))
      .where(eq(payments.orderId, orderId));
    return rows.map((r) => r.alert).sort();
  }

  /** Pedido com Pix pendente, criado há `minutesAgo` minutos (a conciliação ignora os de < 2 min). */
  async function orderWithPix(variantId: string, minutesAgo = 5) {
    const res = await http()
      .post('/api/orders')
      .set('X-Forwarded-For', nextIp())
      .send({ items: [{ variantId, quantity: 1 }], customer })
      .expect(201);
    const orderId = (res.body as { id: string }).id;
    await http().post(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp()).expect(201);
    await ctx.db
      .update(payments)
      .set({ createdAt: new Date(Date.now() - minutesAgo * 60_000) })
      .where(eq(payments.orderId, orderId));
    const { providerPaymentId } = await paymentOf(orderId);
    return { orderId, paymentId: providerPaymentId };
  }

  function setRemote(id: string, over: Partial<ProviderPayment>) {
    mp.remote.set(id, { ...mp.remote.get(id)!, ...over });
  }
  const approve = (id: string, over: Partial<ProviderPayment> = {}) =>
    setRemote(id, { ...mpStatus.approved, dateLastUpdated: new Date(), ...over });

  /** Faz o pagamento parecer conferido há `secondsAgo` segundos (null: nunca conferido). */
  async function checkedAgo(orderId: string, secondsAgo: number | null) {
    await ctx.db
      .update(payments)
      .set({ lastCheckedAt: secondsAgo === null ? null : new Date(Date.now() - secondsAgo * 1000) })
      .where(eq(payments.orderId, orderId));
  }

  /** Faz o backoff da conciliação parecer vencido (spec-020): `next_check_at` no passado. */
  async function backoffElapsed(orderId: string) {
    await ctx.db
      .update(payments)
      .set({ nextCheckAt: new Date(Date.now() - 1000) })
      .where(eq(payments.orderId, orderId));
  }

  const checkedIds = () => mp.getSpy.mock.calls.map((c) => c[0]).sort();
  const warnings = () => warn.mock.calls.map((c) => String(c[0]));

  function webhook(dataId: string) {
    const requestId = randomUUID();
    return http()
      .post(`/api/webhooks/mercadopago?data.id=${dataId}&type=order`)
      .set('X-Forwarded-For', nextIp())
      .set('x-request-id', requestId)
      .set('x-signature', signature(dataId, requestId))
      .send({ type: 'order', action: 'order.processed', data: { id: dataId } });
  }

  describe('rodada de conciliação', () => {
    it('PENDING aprovado no prazo vira PAID e baixa o estoque uma vez; repetir não muda nada', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const { orderId, paymentId } = await orderWithPix(v.id);
      approve(paymentId);

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
      const paid = await paymentOf(orderId);
      expect(paid).toMatchObject({ status: 'APPROVED', alert: null });

      // Mesma rodada de novo, logo depois: nada a conferir (checado há menos de 20 s).
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
      // E mesmo forçando a reconferência, nada muda.
      await checkedAgo(orderId, null);
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      expect(mp.getSpy).toHaveBeenCalledTimes(2);
      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'APPROVED',
        alert: null,
        approvedAt: paid.approvedAt,
      });
      expect(await alertsOf(orderId)).toEqual([]);
    });

    it('aprovado depois do prazo → PAID_AFTER_EXPIRY; pedido já pago → DUPLICATE_PAYMENT', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const late = await orderWithPix(v.id);
      const paidByAdmin = await orderWithPix(v.id);
      await ctx.db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(orders.id, late.orderId));
      await ctx.app.get(AdminOrdersService).updateStatus(paidByAdmin.orderId, 'PAID');
      // Pago pelo painel antes da spec-019, quando o Pix ficava PENDING (hoje o painel o cancela).
      await ctx.db
        .update(payments)
        .set({ status: 'PENDING' })
        .where(eq(payments.orderId, paidByAdmin.orderId));
      approve(late.paymentId);
      approve(paidByAdmin.paymentId);

      expect(await reconciliation.reconcile()).toEqual({ checked: 2, failed: 0 });

      expect(await orderStatus(late.orderId)).toBe('PENDING_PAYMENT');
      expect(await paymentOf(late.orderId)).toMatchObject({
        status: 'APPROVED',
        alert: 'PAID_AFTER_EXPIRY',
      });
      expect(await alertsOf(late.orderId)).toEqual(['PAID_AFTER_EXPIRY']);
      expect(await orderStatus(paidByAdmin.orderId)).toBe('PAID');
      expect(await alertsOf(paidByAdmin.orderId)).toEqual(['DUPLICATE_PAYMENT']);
      // Uma unidade vendida pelo painel; a outra continua reservada pelo pedido atrasado.
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
    });

    it.each([
      ['canceled/canceled', 'CANCELLED', mpStatus.canceled],
      ['failed/expired', 'CANCELLED', mpStatus.expired],
      ['failed/failed', 'REJECTED', mpStatus.rejected],
    ] as const)(
      'MP %s → payments.status %s, pedido não muda',
      async (_label, local, remoteStatus) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, remoteStatus);

        await reconciliation.reconcile();

        expect((await paymentOf(orderId)).status).toBe(local);
        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
      },
    );

    it('seleção: janela de 2 min a 24 h, 20 s desde a última consulta, APPROVED de até 7 dias a cada 6 h', async () => {
      const v = await variantWithStock('05-camiseta-preta', 10);
      const tooNew = await orderWithPix(v.id, 1);
      const tooOld = await orderWithPix(v.id, 25 * 60);
      const justChecked = await orderWithPix(v.id);
      await checkedAgo(justChecked.orderId, 10);
      const due = await orderWithPix(v.id);
      await checkedAgo(due.orderId, 30);

      const approved = async (approvedDaysAgo: number, checkedHoursAgo: number | null) => {
        const o = await orderWithPix(v.id);
        const at = new Date(Date.now() - approvedDaysAgo * 86_400_000);
        await ctx.db
          .update(payments)
          .set({ status: 'APPROVED', approvedAt: at, createdAt: new Date(at.getTime() - 60_000) })
          .where(eq(payments.orderId, o.orderId));
        await checkedAgo(o.orderId, checkedHoursAgo === null ? null : checkedHoursAgo * 3600);
        approve(o.paymentId, { dateLastUpdated: at });
        return o;
      };
      const approvedOld = await approved(8, null);
      const approvedDue = await approved(2, 7);
      const approvedFresh = await approved(2, 1);
      const approvedNever = await approved(6, null);

      expect(await reconciliation.reconcile()).toEqual({ checked: 3, failed: 0 });
      expect(checkedIds()).toEqual(
        [due.paymentId, approvedDue.paymentId, approvedNever.paymentId].sort(),
      );
      for (const skipped of [tooNew, tooOld, justChecked, approvedOld, approvedFresh]) {
        expect(checkedIds()).not.toContain(skipped.paymentId);
      }
    });

    it(`no máximo ${RECONCILIATION_BATCH} por rodada, os nunca conferidos primeiro`, async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId: pendingId } = await orderWithPix(v.id);
      await checkedAgo(orderId, 60);
      const total = RECONCILIATION_BATCH + 5;
      const ids = Array.from({ length: total }, (_, i) => fakeOrderId(2_000_000 + i));
      const at = new Date(Date.now() - 86_400_000);
      await ctx.db.insert(payments).values(
        ids.map((id) => ({
          orderId,
          providerPaymentId: id,
          status: 'APPROVED' as const,
          amountCents: 100,
          expiresAt: at,
          approvedAt: at,
          createdAt: at,
        })),
      );
      for (const id of ids) {
        mp.remote.set(id, {
          id,
          ...mpStatus.approved,
          externalReference: orderId,
          amountCents: 100,
          paidAmountCents: 100,
          currency: 'BRL',
          dateLastUpdated: at,
        });
      }

      expect(await reconciliation.reconcile()).toEqual({
        checked: RECONCILIATION_BATCH,
        failed: 0,
      });
      // O pendente já conferido uma vez fica para depois dos nunca conferidos.
      expect(checkedIds()).not.toContain(pendingId);
      expect(await reconciliation.reconcile()).toEqual({ checked: 6, failed: 0 });
      expect(new Set(checkedIds()).size).toBe(total + 1);
    });

    it('rodadas simultâneas (várias instâncias) não consultam o mesmo pagamento duas vezes', async () => {
      const v = await variantWithStock('05-camiseta-preta', 20);
      const created: { orderId: string; paymentId: string }[] = [];
      for (let i = 0; i < 12; i++) created.push(await orderWithPix(v.id));
      for (const o of created) approve(o.paymentId);

      const results = await Promise.all(
        Array.from({ length: 4 }, () => reconciliation.reconcile()),
      );

      expect(results.reduce((sum, r) => sum + r.checked, 0)).toBe(created.length);
      expect(mp.getSpy).toHaveBeenCalledTimes(created.length);
      expect(new Set(checkedIds()).size).toBe(created.length);
      for (const o of created) expect(await orderStatus(o.orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 20 - created.length, reserved: 0 });
    });

    it('pagamento travado por outra instância no meio da reivindicação é pulado, sem esperar', async () => {
      const v = await variantWithStock('05-camiseta-preta', 5);
      const held = await orderWithPix(v.id);
      const free = [await orderWithPix(v.id), await orderWithPix(v.id)];
      for (const o of [held, ...free]) approve(o.paymentId);

      // Outra instância reivindicou `held` e ainda não fez commit.
      let locked!: () => void;
      let release!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const otherInstance = ctx.db.transaction(async (tx) => {
        await tx
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.orderId, held.orderId))
          .for('update');
        locked();
        await released;
        await tx
          .update(payments)
          .set({ lastCheckedAt: sql`now()` })
          .where(eq(payments.orderId, held.orderId));
      });
      await isLocked;

      const round = reconciliation.reconcile();
      const first = await Promise.race([round, sleep(3000).then(() => 'bloqueou' as const)]);
      release();
      await otherInstance;
      await round;

      expect(first).toEqual({ checked: 2, failed: 0 });
      expect(checkedIds()).toEqual(free.map((o) => o.paymentId).sort());
      // Depois do commit da outra instância, o pagamento dela também não é pego (20 s).
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
      expect(checkedIds()).not.toContain(held.paymentId);
    });

    it('erro do MP num pagamento não interrompe a rodada; a próxima tenta de novo', async () => {
      const v = await variantWithStock('05-camiseta-preta', 5);
      const a = await orderWithPix(v.id);
      const broken = await orderWithPix(v.id);
      const c = await orderWithPix(v.id);
      for (const o of [a, broken, c]) approve(o.paymentId);
      const real = mp.getSpy.getMockImplementation()!;
      mp.getSpy.mockImplementation(async (id) => {
        if (id === broken.paymentId) throw new PixProviderError('Mercado Pago respondeu 500.');
        return real(id);
      });

      expect(await reconciliation.reconcile()).toEqual({ checked: 3, failed: 1 });
      expect(await orderStatus(a.orderId)).toBe('PAID');
      expect(await orderStatus(c.orderId)).toBe('PAID');
      expect(await orderStatus(broken.orderId)).toBe('PENDING_PAYMENT');
      expect(warnings().some((w) => w.includes(broken.paymentId))).toBe(true);

      // A falha devolveu o last_checked_at anterior; só o backoff (spec-020) separa as tentativas.
      mp.getSpy.mockImplementation(real);
      await backoffElapsed(broken.orderId);
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      expect(await orderStatus(broken.orderId)).toBe('PAID');
    });

    it('erro do MP num APPROVED: a rodada seguinte tenta de novo (não espera 6 h)', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      approve(paymentId);
      await reconciliation.reconcile();
      expect(await orderStatus(orderId)).toBe('PAID');
      await checkedAgo(orderId, 7 * 3600);
      const before = (await paymentOf(orderId)).lastCheckedAt;
      setRemote(paymentId, mpStatus.chargedBack);
      mp.getSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago indisponível (rede).'));

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
      expect((await paymentOf(orderId)).lastCheckedAt).toEqual(before);

      // Espera só o backoff (spec-020), não as 6 h.
      await backoffElapsed(orderId);
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      // Agora conferido: só volta daqui a 6 h.
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
    });

    it('falha não devolve o last_checked_at se outra consulta conferiu o pagamento no meio', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const newer = new Date(Date.now() + 60_000);
      mp.getSpy.mockImplementationOnce(async () => {
        await ctx.db
          .update(payments)
          .set({ lastCheckedAt: newer })
          .where(eq(payments.orderId, orderId));
        throw new PixProviderError('Mercado Pago respondeu 500.');
      });

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
      expect(mp.getSpy).toHaveBeenCalledWith(paymentId);
      expect((await paymentOf(orderId)).lastCheckedAt).toEqual(newer);
    });
  });

  describe('teto e backoff da conciliação (spec-020)', () => {
    let error: jest.SpyInstance;
    let intervalMs: number;
    beforeEach(() => {
      error = jest.spyOn(Logger.prototype, 'error');
      intervalMs = ctx.app.get<Env>(ENV).PAYMENT_RECONCILIATION_INTERVAL_MS;
    });

    /** Some do "Mercado Pago": toda consulta dá 404, como no achado 4 da homologação. */
    const goneFromMp = (paymentId: string) => mp.remote.delete(paymentId);

    /** `next_check_at` a `ms` de agora, com folga para a latência do teste. */
    function expectNextCheckIn(row: { nextCheckAt: Date | null }, ms: number) {
      expect(row.nextCheckAt).not.toBeNull();
      const diff = row.nextCheckAt!.getTime() - Date.now();
      expect(Math.abs(diff - ms)).toBeLessThan(5_000);
    }

    /** Rodadas com o backoff vencido até a `failures`-ésima falha seguida do pagamento. */
    async function failUntil(orderId: string, failures: number) {
      for (let n = (await paymentOf(orderId)).checkFailures + 1; n <= failures; n++) {
        await backoffElapsed(orderId);
        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
        expect((await paymentOf(orderId)).checkFailures).toBe(n);
      }
    }

    const stoppedLogs = (paymentId: string) =>
      error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(paymentId));

    it('falha conta 1 e agenda a próxima consulta para daqui a um intervalo; antes disso não consulta', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      goneFromMp(paymentId);

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
      const row = await paymentOf(orderId);
      expect(row.checkFailures).toBe(1);
      expectNextCheckIn(row, intervalMs);
      expect(row.lastCheckedAt).toBeNull();
      expect(
        warnings().some(
          (w) => w.includes(paymentId) && w.includes(`(1/${RECONCILIATION_MAX_FAILURES})`),
        ),
      ).toBe(true);

      // Fora dos 20 s e sem o backoff vencido: continua de fora.
      await checkedAgo(orderId, 60);
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
      expect(mp.getSpy).toHaveBeenCalledTimes(1);
    });

    it('retrodatando next_check_at, volta a ser consultado e o atraso dobra', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      goneFromMp(paymentId);
      await reconciliation.reconcile();

      await backoffElapsed(orderId);
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
      expect(mp.getSpy).toHaveBeenCalledTimes(2);
      const row = await paymentOf(orderId);
      expect(row.checkFailures).toBe(2);
      expectNextCheckIn(row, 2 * intervalMs);
    });

    it('8ª falha seguida: 1 alerta RECONCILIATION_STOPPED, nunca mais consultado; pagamento, pedido e estoque intactos', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      goneFromMp(paymentId);

      for (let n = 1; n < RECONCILIATION_MAX_FAILURES; n++) {
        await failUntil(orderId, n);
        expectNextCheckIn(await paymentOf(orderId), reconciliationDelayMs(n, intervalMs));
      }
      expect(await alertsOf(orderId)).toEqual([]);
      expect(stoppedLogs(paymentId)).toEqual([]);

      await failUntil(orderId, RECONCILIATION_MAX_FAILURES);
      expect(mp.getSpy).toHaveBeenCalledTimes(RECONCILIATION_MAX_FAILURES);
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'PENDING',
        checkFailures: RECONCILIATION_MAX_FAILURES,
        nextCheckAt: null,
        alert: 'RECONCILIATION_STOPPED',
      });
      expect(await alertsOf(orderId)).toEqual(['RECONCILIATION_STOPPED']);
      expect(stoppedLogs(paymentId)).toHaveLength(1);
      expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });

      // Nem com o backoff e os 20 s vencidos: no teto, a conciliação não consulta mais.
      await backoffElapsed(orderId);
      await checkedAgo(orderId, null);
      for (let i = 0; i < 2; i++) {
        expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
      }
      expect(mp.getSpy).toHaveBeenCalledTimes(RECONCILIATION_MAX_FAILURES);
      expect(await alertsOf(orderId)).toEqual(['RECONCILIATION_STOPPED']);
      expect(stoppedLogs(paymentId)).toHaveLength(1);
      const logs = [...warnings(), ...error.mock.calls.map((c) => String(c[0]))].join('\n');
      for (const secret of [customer.email, customer.phone, customer.name]) {
        expect(logs).not.toContain(secret);
      }
    });

    it('consulta bem-sucedida depois de falhas zera check_failures e next_check_at', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const remote = mp.remote.get(paymentId)!;
      goneFromMp(paymentId);
      await failUntil(orderId, 3);

      mp.remote.set(paymentId, remote);
      approve(paymentId);
      await backoffElapsed(orderId);
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

      expect(await paymentOf(orderId)).toMatchObject({
        status: 'APPROVED',
        checkFailures: 0,
        nextCheckAt: null,
      });
      expect(await orderStatus(orderId)).toBe('PAID');
    });

    it('verificação sob demanda (página do pedido) com resposta do MP também zera', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const remote = mp.remote.get(paymentId)!;
      goneFromMp(paymentId);
      await failUntil(orderId, 3);

      mp.remote.set(paymentId, remote);
      approve(paymentId);
      await http().get(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp()).expect(200);

      expect(await paymentOf(orderId)).toMatchObject({
        status: 'APPROVED',
        checkFailures: 0,
        nextCheckAt: null,
      });
      expect(await orderStatus(orderId)).toBe('PAID');
    });

    it('resposta do cancelamento pelo painel (syncFrom) também zera, inclusive no teto', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const remote = mp.remote.get(paymentId)!;
      goneFromMp(paymentId);
      await failUntil(orderId, RECONCILIATION_MAX_FAILURES);

      mp.remote.set(paymentId, remote);
      await ctx.app.get(AdminOrdersService).updateStatus(orderId, 'CANCELED');

      expect(mp.cancelSpy).toHaveBeenCalledWith(paymentId);
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'CANCELLED',
        checkFailures: 0,
        nextCheckAt: null,
      });
      expect(await orderStatus(orderId)).toBe('CANCELED');
      expect(await alertsOf(orderId)).toEqual(['RECONCILIATION_STOPPED']);
    });

    it('webhook depois do teto aplica o status do MP e zera o contador; o alerta fica no histórico', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const remote = mp.remote.get(paymentId)!;
      goneFromMp(paymentId);
      await failUntil(orderId, RECONCILIATION_MAX_FAILURES);

      mp.remote.set(paymentId, remote);
      approve(paymentId);
      await webhook(paymentId).expect(200);

      expect(await paymentOf(orderId)).toMatchObject({
        status: 'APPROVED',
        checkFailures: 0,
        nextCheckAt: null,
      });
      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
      expect(await alertsOf(orderId)).toEqual(['RECONCILIATION_STOPPED']);
      // De volta ao fluxo normal: o APPROVED volta a ser conferido (estorno) depois de 6 h.
      await checkedAgo(orderId, 7 * 3600);
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
    });

    it('webhook bem-sucedido entre a reivindicação e a falha: a falha não conta (contador já zero)', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      // A consulta da conciliação demora e falha; no meio, o webhook consulta o MP com sucesso
      // (o status continua pending, então nada mais muda no pagamento).
      mp.getSpy.mockImplementationOnce(async () => {
        await webhook(paymentId).expect(200);
        throw new PixProviderError('Mercado Pago indisponível (tempo esgotado).');
      });

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
      expect(mp.getSpy).toHaveBeenCalledTimes(2);
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'PENDING',
        checkFailures: 0,
        nextCheckAt: null,
      });
    });

    it(`${RECONCILIATION_BATCH} pagamentos falhando para sempre não impedem a consulta de um saudável`, async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const healthy = await orderWithPix(v.id);
      approve(healthy.paymentId);
      // O saudável já foi conferido uma vez: os nunca conferidos (os quebrados) vêm antes dele.
      await checkedAgo(healthy.orderId, 60);
      const at = new Date(Date.now() - 10 * 60_000);
      const brokenOrders = await ctx.db
        .insert(orders)
        .values(
          Array.from({ length: RECONCILIATION_BATCH }, () => ({
            customerName: customer.name,
            customerEmail: customer.email,
            customerPhone: customer.phone,
            totalCents: 100,
            expiresAt: new Date(Date.now() + 20 * 60_000),
          })),
        )
        .returning({ id: orders.id });
      await ctx.db.insert(payments).values(
        brokenOrders.map((o, i) => ({
          orderId: o.id,
          providerPaymentId: fakeOrderId(3_000_000 + i),
          status: 'PENDING' as const,
          amountCents: 100,
          expiresAt: new Date(Date.now() + 20 * 60_000),
          createdAt: at,
        })),
      );

      expect(await reconciliation.reconcile()).toEqual({
        checked: RECONCILIATION_BATCH,
        failed: RECONCILIATION_BATCH,
      });
      expect(checkedIds()).not.toContain(healthy.paymentId);
      // Antes, os quebrados voltavam ao topo e ocupavam o lote de novo; agora esperam o backoff.
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      expect(await orderStatus(healthy.orderId)).toBe('PAID');
    });

    it('rodadas simultâneas com pagamentos falhando: cada um consultado e contado uma vez', async () => {
      const v = await variantWithStock('05-camiseta-preta', 20);
      const created: { orderId: string; paymentId: string }[] = [];
      for (let i = 0; i < 12; i++) created.push(await orderWithPix(v.id));
      for (const o of created) goneFromMp(o.paymentId);

      const results = await Promise.all(
        Array.from({ length: 4 }, () => reconciliation.reconcile()),
      );

      expect(results.reduce((sum, r) => sum + r.checked, 0)).toBe(12);
      expect(checkedIds()).toEqual(created.map((o) => o.paymentId).sort());
      for (const o of created) {
        const row = await paymentOf(o.orderId);
        expect(row.checkFailures).toBe(1);
        expectNextCheckIn(row, intervalMs);
      }
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
    });

    it('vale para APPROVED na verificação de estorno: backoff sem esperar 6 h e teto com alerta', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      approve(paymentId);
      await reconciliation.reconcile();
      expect(await orderStatus(orderId)).toBe('PAID');
      await checkedAgo(orderId, 7 * 3600);
      const before = (await paymentOf(orderId)).lastCheckedAt;
      goneFromMp(paymentId);

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
      const row = await paymentOf(orderId);
      expect(row).toMatchObject({ checkFailures: 1, lastCheckedAt: before });
      expectNextCheckIn(row, intervalMs);
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });

      await failUntil(orderId, RECONCILIATION_MAX_FAILURES);
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'APPROVED',
        checkFailures: RECONCILIATION_MAX_FAILURES,
        nextCheckAt: null,
      });
      expect(await alertsOf(orderId)).toEqual(['RECONCILIATION_STOPPED']);
      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
      await backoffElapsed(orderId);
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
    });

    describe('order sem classificação em cobrança PENDING (spec-028)', () => {
      const unclassified = [
        ['processed/<desconhecido>', { status: 'processed', statusDetail: 'em_revisao' }],
        ['processed/null', { status: 'processed', statusDetail: null }],
        ['cancelled/cancelled', { status: 'cancelled', statusDetail: 'cancelled' }],
      ] as const;

      it.each(unclassified)(
        '%s: soma a cada rodada, respeita next_check_at, para na 8ª e não é mais selecionada',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          setRemote(paymentId, remoteStatus);

          for (let n = 1; n < RECONCILIATION_MAX_FAILURES; n++) {
            await failUntil(orderId, n);
            expect(mp.getSpy).toHaveBeenCalledTimes(n);
            expectNextCheckIn(await paymentOf(orderId), reconciliationDelayMs(n, intervalMs));
            // Fora dos 20 s e sem o backoff vencido: continua de fora.
            await checkedAgo(orderId, 60);
            expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
            expect(mp.getSpy).toHaveBeenCalledTimes(n);
          }
          expect(await alertsOf(orderId)).toEqual([]);
          expect(stoppedLogs(paymentId)).toEqual([]);

          await failUntil(orderId, RECONCILIATION_MAX_FAILURES);
          expect(await paymentOf(orderId)).toMatchObject({
            status: 'PENDING',
            checkFailures: RECONCILIATION_MAX_FAILURES,
            nextCheckAt: null,
            alert: 'RECONCILIATION_STOPPED',
          });
          expect(await alertsOf(orderId)).toEqual(['RECONCILIATION_STOPPED']);
          expect(stoppedLogs(paymentId)).toHaveLength(1);
          // Nunca paga nem encerra por conta própria: ali pode haver dinheiro recebido.
          expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
          expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
          // O alerta não guarda motivo: o status e o detalhe vão para o log a cada consulta.
          const seen = `"${remoteStatus.status}/${remoteStatus.statusDetail ?? ''}"`;
          expect(
            warnings().filter((w) => w.includes(seen) && w.includes(paymentId)).length,
          ).toBeGreaterThanOrEqual(RECONCILIATION_MAX_FAILURES);

          await backoffElapsed(orderId);
          await checkedAgo(orderId, null);
          expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
          expect(mp.getSpy).toHaveBeenCalledTimes(RECONCILIATION_MAX_FAILURES);
        },
      );

      it('falha real e resposta sem classificação somam no mesmo contador, em sequência', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const remote = mp.remote.get(paymentId)!;

        goneFromMp(paymentId);
        await failUntil(orderId, 1);
        mp.remote.set(paymentId, { ...remote, status: 'processed', statusDetail: null });
        await failUntil(orderId, 2);
        goneFromMp(paymentId);
        await failUntil(orderId, 3);

        expectNextCheckIn(await paymentOf(orderId), reconciliationDelayMs(3, intervalMs));
      });

      it.each(unclassified)(
        'webhook com %s não soma nem zera, nem no meio do backoff nem no teto',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          setRemote(paymentId, remoteStatus);
          await failUntil(orderId, 3);
          const midway = await paymentOf(orderId);

          await webhook(paymentId).expect(200);
          expect(await paymentOf(orderId)).toEqual(midway);

          await failUntil(orderId, RECONCILIATION_MAX_FAILURES);
          const stopped = await paymentOf(orderId);
          await webhook(paymentId).expect(200);
          expect(await paymentOf(orderId)).toEqual(stopped);
        },
      );

      it('verificação sob demanda com resposta sem classificação não soma nem zera', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, { status: 'processed', statusDetail: null });
        await failUntil(orderId, 3);
        const { nextCheckAt } = await paymentOf(orderId);
        mp.getSpy.mockClear();

        await http().get(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp()).expect(200);

        expect(mp.getSpy).toHaveBeenCalledTimes(1);
        expect(await paymentOf(orderId)).toMatchObject({
          status: 'PENDING',
          checkFailures: 3,
          nextCheckAt,
        });
      });

      it('resposta do cancelamento sem classificação não soma nem zera, e o cancelamento falha', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const remote = mp.remote.get(paymentId)!;
        setRemote(paymentId, { status: 'processed', statusDetail: null });
        await failUntil(orderId, 3);
        const before = await paymentOf(orderId);
        mp.cancelSpy.mockResolvedValueOnce({ ...remote, status: 'processed', statusDetail: null });

        await expect(
          ctx.app.get(AdminOrdersService).updateStatus(orderId, 'CANCELED'),
        ).rejects.toThrow(/Não foi possível cancelar o Pix/);

        expect(await paymentOf(orderId)).toEqual(before);
        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
      });

      it('webhook sem classificação no meio da consulta da rodada: a falha da rodada conta', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, { status: 'processed', statusDetail: null });
        const remote = mp.remote.get(paymentId)!;
        mp.getSpy.mockImplementationOnce(async () => {
          await webhook(paymentId).expect(200);
          return { ...remote };
        });

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });

        expect(mp.getSpy).toHaveBeenCalledTimes(2);
        const row = await paymentOf(orderId);
        expect(row.checkFailures).toBe(1);
        expectNextCheckIn(row, intervalMs);
      });

      it('webhook com status conhecido no meio da consulta da rodada: a resposta sem classificação não conta', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const remote = mp.remote.get(paymentId)!;
        mp.getSpy.mockImplementationOnce(async () => {
          await webhook(paymentId).expect(200);
          return { ...remote, status: 'processed', statusDetail: null };
        });

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });

        expect(await paymentOf(orderId)).toMatchObject({
          status: 'PENDING',
          checkFailures: 0,
          nextCheckAt: null,
        });
      });

      it('status conhecido depois do teto aplica a transição e zera; o alerta fica no histórico', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, { status: 'processed', statusDetail: 'em_revisao' });
        await failUntil(orderId, RECONCILIATION_MAX_FAILURES);

        approve(paymentId);
        await webhook(paymentId).expect(200);

        expect(await paymentOf(orderId)).toMatchObject({
          status: 'APPROVED',
          checkFailures: 0,
          nextCheckAt: null,
        });
        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
        expect(await alertsOf(orderId)).toEqual(['RECONCILIATION_STOPPED']);
      });

      it('status conhecido ainda pendente depois do teto zera, e a conciliação volta a selecionar', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, { status: 'processed', statusDetail: null });
        await failUntil(orderId, RECONCILIATION_MAX_FAILURES);

        setRemote(paymentId, mpStatus.pending);
        await webhook(paymentId).expect(200);

        expect(await paymentOf(orderId)).toMatchObject({
          status: 'PENDING',
          checkFailures: 0,
          nextCheckAt: null,
        });
        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      });

      it.each([
        ['processed/<desconhecido>', { status: 'processed', statusDetail: 'em_revisao' }],
        ['processed/null', { status: 'processed', statusDetail: null }],
        ['cancelled/cancelled', { status: 'cancelled', statusDetail: 'cancelled' }],
        ['failed/<desconhecido>', { status: 'failed', statusDetail: 'em_revisao' }],
        ['failed/null', { status: 'failed', statusDetail: null }],
      ] as const)(
        'cobrança APPROVED + %s: nada muda, sem falha, e a reconsulta de 6 h continua',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          approve(paymentId);
          await reconciliation.reconcile();
          const paid = await paymentOf(orderId);
          setRemote(paymentId, remoteStatus);

          await checkedAgo(orderId, 7 * 3600);
          expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

          const row = await paymentOf(orderId);
          expect(row).toMatchObject({
            status: 'APPROVED',
            checkFailures: 0,
            nextCheckAt: null,
            alert: null,
            approvedAt: paid.approvedAt,
          });
          expect(await alertsOf(orderId)).toEqual([]);
          expect(await orderStatus(orderId)).toBe('PAID');
          expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });

          // Conferido agora: só volta daqui a 6 h, e então volta.
          expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
          await checkedAgo(orderId, 7 * 3600);
          expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
        },
      );
    });

    describe('charged_back em cobrança PENDING (spec-029, simulação: o sandbox não mostrou um)', () => {
      const chargedBack = [
        ['charged_back/in_process', mpStatus.chargedBack],
        ['charged_back/settled', { status: 'charged_back', statusDetail: 'settled' }],
        ['charged_back/reimbursed', { status: 'charged_back', statusDetail: 'reimbursed' }],
      ] as const;

      const reversedLogs = (paymentId: string) =>
        warnings().filter((w) => w.includes(paymentId) && w.includes('alerta PAYMENT_REVERSED'));

      /** Só o alerta é novo: cobrança PENDING sem `approved_at`, pedido e estoque como estavam. */
      async function expectOnlyAlert(
        orderId: string,
        variantId: string,
        order: OrderStatus,
        stock: { stock: number; reserved: number },
      ) {
        expect(await paymentOf(orderId)).toMatchObject({
          status: 'PENDING',
          approvedAt: null,
          alert: 'PAYMENT_REVERSED',
        });
        expect(await orderStatus(orderId)).toBe(order);
        expect(await stockOf(variantId)).toEqual(stock);
      }

      it.each(chargedBack)(
        '(a) conciliação: %s grava PAYMENT_REVERSED na 1ª resposta e conta a falha',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          setRemote(paymentId, remoteStatus);

          expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });

          expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
          await expectOnlyAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
          const row = await paymentOf(orderId);
          expect(row.checkFailures).toBe(1);
          expectNextCheckIn(row, intervalMs);
          expect(reversedLogs(paymentId)).toEqual([
            `Pagamento ${paymentId} do pedido ${orderId}: alerta PAYMENT_REVERSED.`,
          ]);
          const seen = `"${remoteStatus.status}/${remoteStatus.statusDetail}"`;
          expect(warnings().some((w) => w.includes(seen) && w.includes(paymentId))).toBe(true);
        },
      );

      it.each(chargedBack)(
        '(a) webhook: %s grava PAYMENT_REVERSED na 1ª resposta, sem somar nem zerar',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          setRemote(paymentId, remoteStatus);

          await webhook(paymentId).expect(200);

          expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
          await expectOnlyAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
          expect(await paymentOf(orderId)).toMatchObject({ checkFailures: 0, nextCheckAt: null });
          expect(reversedLogs(paymentId)).toHaveLength(1);
        },
      );

      it.each(chargedBack)(
        '(a) GET /pix: %s grava PAYMENT_REVERSED na 1ª resposta, sem somar nem zerar',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          setRemote(paymentId, remoteStatus);
          mp.getSpy.mockClear();

          await http()
            .get(`/api/orders/${orderId}/pix`)
            .set('X-Forwarded-For', nextIp())
            .expect(200);

          expect(mp.getSpy).toHaveBeenCalledTimes(1);
          expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
          await expectOnlyAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
          expect(await paymentOf(orderId)).toMatchObject({ checkFailures: 0, nextCheckAt: null });
          expect(reversedLogs(paymentId)).toHaveLength(1);
        },
      );

      it.each(chargedBack)(
        '(b) %s: o backoff da spec-028 segue igual e a 8ª rodada grava RECONCILIATION_STOPPED',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          setRemote(paymentId, remoteStatus);

          for (let n = 1; n < RECONCILIATION_MAX_FAILURES; n++) {
            await failUntil(orderId, n);
            expect(mp.getSpy).toHaveBeenCalledTimes(n);
            expectNextCheckIn(await paymentOf(orderId), reconciliationDelayMs(n, intervalMs));
            await checkedAgo(orderId, 60);
            expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
            expect(mp.getSpy).toHaveBeenCalledTimes(n);
            expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
          }
          expect(stoppedLogs(paymentId)).toEqual([]);

          await failUntil(orderId, RECONCILIATION_MAX_FAILURES);
          // payments.alert fica com o primeiro (COALESCE); o painel lista os dois, um por linha.
          expect(await paymentOf(orderId)).toMatchObject({
            status: 'PENDING',
            approvedAt: null,
            checkFailures: RECONCILIATION_MAX_FAILURES,
            nextCheckAt: null,
            alert: 'PAYMENT_REVERSED',
          });
          expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED', 'RECONCILIATION_STOPPED']);
          expect(stoppedLogs(paymentId)).toHaveLength(1);
          expect(reversedLogs(paymentId)).toHaveLength(1);
          expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
          expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
          const seen = `"${remoteStatus.status}/${remoteStatus.statusDetail}"`;
          expect(
            warnings().filter((w) => w.includes(seen) && w.includes(paymentId)).length,
          ).toBeGreaterThanOrEqual(RECONCILIATION_MAX_FAILURES);

          await backoffElapsed(orderId);
          await checkedAgo(orderId, null);
          expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
          expect(mp.getSpy).toHaveBeenCalledTimes(RECONCILIATION_MAX_FAILURES);
        },
      );

      it('(c) webhook repetido não duplica o alerta nem soma ou zera, no meio do backoff e no teto', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, mpStatus.chargedBack);
        await webhook(paymentId).expect(200);
        await webhook(paymentId).expect(200);
        await failUntil(orderId, 3);
        const midway = await paymentOf(orderId);

        await webhook(paymentId).expect(200);
        expect(await paymentOf(orderId)).toEqual(midway);

        await failUntil(orderId, RECONCILIATION_MAX_FAILURES);
        const stopped = await paymentOf(orderId);
        await webhook(paymentId).expect(200);
        expect(await paymentOf(orderId)).toEqual(stopped);
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED', 'RECONCILIATION_STOPPED']);
        expect(reversedLogs(paymentId)).toHaveLength(1);
      });

      it('(d) pedido expirado: a resposta do cancelamento grava PAYMENT_REVERSED, pedido segue EXPIRED', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, mpStatus.chargedBack);

        await ctx.app.get(OrderExpirationService).run(new Date(Date.now() + 31 * 60_000));

        await expect(mp.cancelSpy.mock.results[0].value).rejects.toMatchObject({
          notCancellable: true,
        });
        expect(mp.getSpy).toHaveBeenCalledWith(paymentId);
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
        await expectOnlyAlert(orderId, v.id, 'EXPIRED', { stock: 2, reserved: 0 });
        expect(await paymentOf(orderId)).toMatchObject({ checkFailures: 0, nextCheckAt: null });
        expect(warnings()).toContainEqual(
          `Cancelamento do Pix ${paymentId} falhou (pedido ${orderId}): a cobrança continua pendente.`,
        );

        // A conciliação segue contando falha, sem gravar o alerta de novo.
        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
        expect((await paymentOf(orderId)).checkFailures).toBe(1);
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
        await expectOnlyAlert(orderId, v.id, 'EXPIRED', { stock: 2, reserved: 0 });
        expect(reversedLogs(paymentId)).toHaveLength(1);
      });

      it('pedido já PAID por outro caminho: só o alerta, o pedido não muda', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        await ctx.app.get(AdminOrdersService).updateStatus(orderId, 'PAID');
        // Pago pelo painel antes da spec-019, quando o Pix ficava PENDING (hoje o painel o cancela).
        await ctx.db
          .update(payments)
          .set({ status: 'PENDING' })
          .where(eq(payments.orderId, orderId));
        setRemote(paymentId, mpStatus.chargedBack);

        await webhook(paymentId).expect(200);

        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
        await expectOnlyAlert(orderId, v.id, 'PAID', { stock: 1, reserved: 0 });
      });
    });

    describe('order failed com detalhe desconhecido ou nulo (spec-028)', () => {
      const failedUnknown = [
        ['failed/<desconhecido>', { status: 'failed', statusDetail: 'em_revisao' }],
        ['failed/null', { status: 'failed', statusDetail: null }],
      ] as const;

      function expectLogged(
        paymentId: string,
        remoteStatus: Pick<ProviderPayment, 'status' | 'statusDetail'>,
      ) {
        const seen = `"${remoteStatus.status}/${remoteStatus.statusDetail ?? ''}"`;
        expect(warnings().some((w) => w.includes(seen) && w.includes(paymentId))).toBe(true);
      }

      it.each(failedUnknown)(
        '%s pela conciliação → REJECTED, zera, não volta à seleção e fica no log',
        async (_label, remoteStatus) => {
          const v = await variantWithStock('05-camiseta-preta', 2);
          const { orderId, paymentId } = await orderWithPix(v.id);
          const remote = mp.remote.get(paymentId)!;
          goneFromMp(paymentId);
          await failUntil(orderId, 2);
          mp.remote.set(paymentId, { ...remote, ...remoteStatus });
          await backoffElapsed(orderId);

          expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

          expect(await paymentOf(orderId)).toMatchObject({
            status: 'REJECTED',
            checkFailures: 0,
            nextCheckAt: null,
            alert: null,
          });
          expect(await alertsOf(orderId)).toEqual([]);
          expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
          expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
          expectLogged(paymentId, remoteStatus);

          await checkedAgo(orderId, null);
          expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
        },
      );

      it.each(failedUnknown)('%s pelo webhook → REJECTED', async (_label, remoteStatus) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, remoteStatus);

        await webhook(paymentId).expect(200);

        expect(await paymentOf(orderId)).toMatchObject({ status: 'REJECTED', alert: null });
        expect(await alertsOf(orderId)).toEqual([]);
        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expectLogged(paymentId, remoteStatus);
      });
    });
  });

  describe('status nunca regride', () => {
    it('canceled ou failed atrasado sobre APPROVED ou REFUNDED não muda nada', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const approvedOrder = await orderWithPix(v.id);
      const refundedOrder = await orderWithPix(v.id);
      for (const o of [approvedOrder, refundedOrder]) approve(o.paymentId);
      await reconciliation.reconcile();
      setRemote(refundedOrder.paymentId, mpStatus.refunded);
      await webhook(refundedOrder.paymentId).expect(200);
      const approvedRow = await paymentOf(approvedOrder.orderId);
      const refundedRow = await paymentOf(refundedOrder.orderId);
      expect(refundedRow.status).toBe('REFUNDED');

      for (const late of [mpStatus.canceled, mpStatus.expired, mpStatus.rejected]) {
        setRemote(approvedOrder.paymentId, late);
        setRemote(refundedOrder.paymentId, late);
        await webhook(approvedOrder.paymentId).expect(200);
        await webhook(refundedOrder.paymentId).expect(200);
      }

      expect(await paymentOf(approvedOrder.orderId)).toEqual(approvedRow);
      expect(await paymentOf(refundedOrder.orderId)).toEqual(refundedRow);
      expect(await orderStatus(approvedOrder.orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
    });

    it('approved atrasado sobre REFUNDED não aprova de novo nem paga o pedido', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      // Estornada antes de ser vista aprovada (pedido nunca pago) e estornada depois de paga.
      const neverPaid = await orderWithPix(v.id);
      setRemote(neverPaid.paymentId, mpStatus.refunded);
      const paid = await orderWithPix(v.id);
      approve(paid.paymentId);
      await reconciliation.reconcile();
      setRemote(paid.paymentId, mpStatus.refunded);
      await webhook(paid.paymentId).expect(200);
      const rows = [await paymentOf(neverPaid.orderId), await paymentOf(paid.orderId)];
      expect(rows.map((r) => r.status)).toEqual(['REFUNDED', 'REFUNDED']);

      // Resposta atrasada do MP (webhook fora de ordem): approved de novo.
      for (const o of [neverPaid, paid]) {
        approve(o.paymentId);
        await webhook(o.paymentId).expect(200);
      }

      expect(await paymentOf(neverPaid.orderId)).toEqual(rows[0]);
      expect(await paymentOf(paid.orderId)).toEqual(rows[1]);
      expect(await orderStatus(neverPaid.orderId)).toBe('PENDING_PAYMENT');
      expect(await orderStatus(paid.orderId)).toBe('PAID');
      expect(await alertsOf(neverPaid.orderId)).toEqual(['PAYMENT_REVERSED']);
      expect(await alertsOf(paid.orderId)).toEqual(['PAYMENT_REVERSED']);
      // Uma unidade vendida (paid) e uma ainda reservada (neverPaid, que segue a própria expiração).
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
    });

    it('PENDING que o MP já mostra refunded vira REFUNDED, com PAYMENT_REVERSED e warn (spec-032)', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, mpStatus.refunded);

      await reconciliation.reconcile();

      expect(await paymentOf(orderId)).toMatchObject({
        status: 'REFUNDED',
        alert: 'PAYMENT_REVERSED',
      });
      expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
      expect(warnings()).toContainEqual(
        expect.stringMatching(/estornado antes de ser visto aprovado/),
      );
      const logged = warnings().find((w) => w.includes('estornado antes'))!;
      expect(logged).toContain(paymentId);
      expect(logged).toContain(orderId);
    });
  });

  describe('estorno antes da 1ª visão e contestação depois do estorno (spec-032, simulação)', () => {
    const later = () => new Date(Date.now() + 31 * 60_000);
    const chargedBack = [
      ['charged_back/in_process', mpStatus.chargedBack],
      ['charged_back/settled', { status: 'charged_back', statusDetail: 'settled' }],
      ['charged_back/reimbursed', { status: 'charged_back', statusDetail: 'reimbursed' }],
    ] as const;

    const reversedLogs = (paymentId: string) =>
      warnings().filter((w) => w.includes(paymentId) && w.includes('alerta PAYMENT_REVERSED'));

    /** Cobrança REFUNDED sem `approved_at`, com o alerta; pedido e estoque como estavam. */
    async function expectRefundedWithAlert(
      orderId: string,
      variantId: string,
      order: OrderStatus,
      stock: { stock: number; reserved: number },
    ) {
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'REFUNDED',
        approvedAt: null,
        alert: 'PAYMENT_REVERSED',
        checkFailures: 0,
        nextCheckAt: null,
      });
      expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      expect(await orderStatus(orderId)).toBe(order);
      expect(await stockOf(variantId)).toEqual(stock);
    }

    function expectRefundedWarn(paymentId: string, orderId: string) {
      expect(warnings()).toContainEqual(
        `Pagamento ${paymentId} do pedido ${orderId} estornado antes de ser visto aprovado.`,
      );
      expect(reversedLogs(paymentId)).toEqual([
        `Pagamento ${paymentId} do pedido ${orderId}: alerta PAYMENT_REVERSED.`,
      ]);
    }

    /** Desfechos de `sync` (webhook e verificação sob demanda), na ordem das chamadas. */
    function syncOutcomes() {
      const spy = jest.spyOn(ctx.app.get(PaymentTransitionService), 'sync');
      return () => Promise.all(spy.mock.results.map((r) => r.value as Promise<string>));
    }

    it('(a) conciliação: PENDING + refunded grava PAYMENT_REVERSED, zera o backoff, sem contar falha', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      await ctx.db.update(payments).set({ checkFailures: 3 }).where(eq(payments.orderId, orderId));
      await backoffElapsed(orderId);
      setRemote(paymentId, mpStatus.refunded);

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

      await expectRefundedWithAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
      expectRefundedWarn(paymentId, orderId);
    });

    it('(a)(c) webhook: PENDING + refunded grava PAYMENT_REVERSED; repetido, não duplica', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, mpStatus.refunded);
      const outcomes = syncOutcomes();

      await webhook(paymentId).expect(200);
      await expectRefundedWithAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
      const row = await paymentOf(orderId);

      await webhook(paymentId).expect(200);
      expect(await outcomes()).toEqual(['updated', 'updated']);
      expect(await paymentOf(orderId)).toEqual(row);
      expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      expectRefundedWarn(paymentId, orderId);
    });

    it('(a) GET /pix: PENDING + refunded grava PAYMENT_REVERSED; o pedido segue esperando', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, mpStatus.refunded);
      mp.getSpy.mockClear();

      await http().get(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp()).expect(200);

      expect(mp.getSpy).toHaveBeenCalledTimes(1);
      await expectRefundedWithAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
      expectRefundedWarn(paymentId, orderId);
    });

    it('(a) cancelamento na expiração: a resposta refunded grava PAYMENT_REVERSED, pedido EXPIRED', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, mpStatus.refunded);

      await ctx.app.get(OrderExpirationService).run(later());

      await expect(mp.cancelSpy.mock.results[0].value).rejects.toMatchObject({
        notCancellable: true,
      });
      expect(mp.getSpy).toHaveBeenCalledWith(paymentId);
      await expectRefundedWithAlert(orderId, v.id, 'EXPIRED', { stock: 2, reserved: 0 });
      expectRefundedWarn(paymentId, orderId);
      expect(warnings().some((w) => w.includes('continua pendente'))).toBe(false);
    });

    it('(a) pedido já EXPIRED: o webhook refunded grava PAYMENT_REVERSED, pedido e estoque intactos', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      await ctx.app.get(OrdersService).releaseExpired(later());
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
      setRemote(paymentId, mpStatus.refunded);

      await webhook(paymentId).expect(200);

      await expectRefundedWithAlert(orderId, v.id, 'EXPIRED', { stock: 2, reserved: 0 });
      expectRefundedWarn(paymentId, orderId);
    });

    it('(a) painel marca pago depois do estorno no MP: pedido PAID, cobrança REFUNDED com alerta', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, mpStatus.refunded);

      await ctx.app.get(AdminOrdersService).updateStatus(orderId, 'PAID');

      await expectRefundedWithAlert(orderId, v.id, 'PAID', { stock: 1, reserved: 0 });
      expectRefundedWarn(paymentId, orderId);
    });

    it.each(chargedBack)(
      '(b) webhook: REFUNDED sem alerta + %s grava PAYMENT_REVERSED, desfecho payment_reversed',
      async (_label, remoteStatus) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        // Estornada antes de ser vista aprovada, antes da spec-032: REFUNDED e nenhum alerta.
        await ctx.db
          .update(payments)
          .set({ status: 'REFUNDED' })
          .where(eq(payments.orderId, orderId));
        expect(await alertsOf(orderId)).toEqual([]);
        setRemote(paymentId, remoteStatus);
        const outcomes = syncOutcomes();

        await webhook(paymentId).expect(200);

        expect(await outcomes()).toEqual(['payment_reversed']);
        await expectRefundedWithAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
        expect(reversedLogs(paymentId)).toEqual([
          `Pagamento ${paymentId} do pedido ${orderId}: alerta PAYMENT_REVERSED.`,
        ]);
        const seen = `"${remoteStatus.status}/${remoteStatus.statusDetail}"`;
        expect(warnings().some((w) => w.includes(seen) && w.includes(paymentId))).toBe(true);

        // Repetido: nada novo no banco nem no log.
        const row = await paymentOf(orderId);
        await webhook(paymentId).expect(200);
        expect(await paymentOf(orderId)).toEqual(row);
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
        expect(reversedLogs(paymentId)).toHaveLength(1);
      },
    );

    it('(b) a conciliação não seleciona a cobrança REFUNDED: o caso só chega por webhook', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      await ctx.db
        .update(payments)
        .set({ status: 'REFUNDED' })
        .where(eq(payments.orderId, orderId));
      setRemote(paymentId, mpStatus.chargedBack);

      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
      expect(mp.getSpy).not.toHaveBeenCalled();
      expect(await alertsOf(orderId)).toEqual([]);
    });

    it('(c) estorno visto antes da aprovação e depois charged_back: uma linha só de PAYMENT_REVERSED', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, mpStatus.refunded);
      await webhook(paymentId).expect(200);
      const row = await paymentOf(orderId);
      const outcomes = syncOutcomes();

      for (const [, remoteStatus] of chargedBack) {
        setRemote(paymentId, remoteStatus);
        await webhook(paymentId).expect(200);
      }

      expect(await outcomes()).toEqual(Array(chargedBack.length).fill('payment_reversed'));
      expect(await paymentOf(orderId)).toEqual(row);
      await expectRefundedWithAlert(orderId, v.id, 'PENDING_PAYMENT', { stock: 2, reserved: 1 });
      expect(reversedLogs(paymentId)).toHaveLength(1);
    });

    it('(c) REFUNDED vinda de APPROVED + charged_back: uma linha só de PAYMENT_REVERSED', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      approve(paymentId);
      await reconciliation.reconcile();
      setRemote(paymentId, mpStatus.refunded);
      await webhook(paymentId).expect(200);
      const row = await paymentOf(orderId);
      expect(row).toMatchObject({ status: 'REFUNDED', alert: 'PAYMENT_REVERSED' });
      const outcomes = syncOutcomes();

      for (const [, remoteStatus] of chargedBack) {
        setRemote(paymentId, remoteStatus);
        await webhook(paymentId).expect(200);
      }

      expect(await outcomes()).toEqual(Array(chargedBack.length).fill('payment_reversed'));
      expect(await paymentOf(orderId)).toEqual(row);
      expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
      expect(reversedLogs(paymentId)).toHaveLength(1);
    });
  });

  describe('estorno ou contestação depois de pago (PAYMENT_REVERSED)', () => {
    it.each([
      ['refunded/refunded', 'REFUNDED', mpStatus.refunded],
      ['charged_back/in_process', 'APPROVED', mpStatus.chargedBack],
      ['charged_back/settled', 'APPROVED', { status: 'charged_back', statusDetail: 'settled' }],
      ['processed/partially_refunded', 'APPROVED', mpStatus.partiallyRefunded],
    ] as const)(
      'MP %s → alerta, cobrança %s, pedido e estoque intactos; repetir não grava nada',
      async (_label, local, remoteStatus) => {
        const v = await variantWithStock('05-camiseta-preta', 3);
        const { orderId, paymentId } = await orderWithPix(v.id);
        approve(paymentId);
        await reconciliation.reconcile();
        expect(await orderStatus(orderId)).toBe('PAID');

        setRemote(paymentId, remoteStatus);
        await checkedAgo(orderId, 7 * 3600);
        await reconciliation.reconcile();

        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
        const reversed = await paymentOf(orderId);
        expect(reversed).toMatchObject({ status: local, alert: 'PAYMENT_REVERSED' });
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
        expect(warnings().filter((w) => w.includes('PAYMENT_REVERSED'))).toHaveLength(1);

        // A mesma notificação de novo, pelo webhook: nada novo no banco nem no log.
        await webhook(paymentId).expect(200);
        expect(await paymentOf(orderId)).toEqual(reversed);
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
        expect(warnings().filter((w) => w.includes('PAYMENT_REVERSED'))).toHaveLength(1);
      },
    );

    it('alertas se acumulam: PAID_AFTER_EXPIRY e depois estorno terminam com os dois', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      await ctx.app.get(OrdersService).releaseExpired(new Date(Date.now() + 31 * 60_000));
      approve(paymentId);
      await webhook(paymentId).expect(200);
      expect(await alertsOf(orderId)).toEqual(['PAID_AFTER_EXPIRY']);

      setRemote(paymentId, mpStatus.refunded);
      await webhook(paymentId).expect(200);
      await webhook(paymentId).expect(200);
      await checkedAgo(orderId, null);
      await reconciliation.reconcile();

      expect(await alertsOf(orderId)).toEqual(['PAID_AFTER_EXPIRY', 'PAYMENT_REVERSED']);
      // payments.alert guarda o primeiro e nunca é sobrescrita.
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'REFUNDED',
        alert: 'PAID_AFTER_EXPIRY',
      });
      expect(await orderStatus(orderId)).toBe('EXPIRED');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
    });

    it('todo alerta gravado vai para o log com ids e tipo, sem dados do cliente', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      await ctx.db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(orders.id, orderId));
      approve(paymentId);

      await reconciliation.reconcile();

      const logged = warnings().filter((w) => w.includes('alerta'));
      expect(logged).toEqual([
        `Pagamento ${paymentId} do pedido ${orderId}: alerta PAID_AFTER_EXPIRY.`,
      ]);
      for (const w of warnings()) {
        expect(w).not.toContain(customer.email);
        expect(w).not.toContain(customer.name);
        expect(w).not.toContain(customer.phone);
      }
    });
  });

  describe('momento da aprovação (a API de Orders não tem data de aprovação)', () => {
    it('usa o last_updated_date da order na primeira vez que ela aparece aprovada', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const expiresAt = new Date(Date.now() - 60_000);
      await ctx.db.update(orders).set({ expiresAt }).where(eq(orders.id, orderId));
      const lastUpdated = new Date(expiresAt.getTime() - 5000);
      approve(paymentId, { dateLastUpdated: lastUpdated });

      await reconciliation.reconcile();

      // Pago dentro do prazo pela data do Mercado Pago, não pela hora da conciliação.
      expect(await orderStatus(orderId)).toBe('PAID');
      expect((await paymentOf(orderId)).approvedAt).toEqual(lastUpdated);

      // Mudança posterior na order (ex.: estorno) não mexe no momento da aprovação.
      setRemote(paymentId, { ...mpStatus.refunded, dateLastUpdated: new Date() });
      await webhook(paymentId).expect(200);
      expect((await paymentOf(orderId)).approvedAt).toEqual(lastUpdated);
    });

    it('sem last_updated_date, usa a hora atual, com warn', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      await ctx.db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(orders.id, orderId));
      approve(paymentId, { dateLastUpdated: null });
      const before = Date.now();

      await reconciliation.reconcile();

      const { approvedAt, alert } = await paymentOf(orderId);
      expect(approvedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(alert).toBe('PAID_AFTER_EXPIRY');
      expect(warnings()).toContainEqual(expect.stringMatching(/hora atual/));
    });
  });

  describe('cancelamento do Pix quando o pedido expira', () => {
    const later = () => new Date(Date.now() + 31 * 60_000);

    it('cancela no MP depois do commit da expiração; o pagamento fica CANCELLED', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const seenAtCancel: { order: OrderStatus; reserved: number }[] = [];
      const real = mp.cancelSpy.getMockImplementation()!;
      mp.cancelSpy.mockImplementation(async (id) => {
        // Outra conexão enxerga a expiração já commitada quando o MP é chamado.
        seenAtCancel.push({
          order: await orderStatus(orderId),
          reserved: (await stockOf(v.id)).reserved,
        });
        return real(id);
      });

      await ctx.app.get(OrderExpirationService).run(later());

      expect(mp.cancelSpy).toHaveBeenCalledTimes(1);
      expect(mp.cancelSpy).toHaveBeenCalledWith(paymentId);
      expect(seenAtCancel).toEqual([{ order: 'EXPIRED', reserved: 0 }]);
      expect((await paymentOf(orderId)).status).toBe('CANCELLED');
      expect(await orderStatus(orderId)).toBe('EXPIRED');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
    });

    it('falha no cancelamento não impede a devolução do estoque; a conciliação confere depois', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      mp.cancelSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago indisponível (rede).'));

      await ctx.app.get(OrderExpirationService).run(later());

      expect(await orderStatus(orderId)).toBe('EXPIRED');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
      expect((await paymentOf(orderId)).status).toBe('PENDING');
      expect(warnings().some((w) => w.includes(paymentId))).toBe(true);

      setRemote(paymentId, mpStatus.expired);
      await reconciliation.reconcile();
      expect((await paymentOf(orderId)).status).toBe('CANCELLED');
    });

    it('MP recusa o cancelamento porque a order já foi paga → GET → PAID_AFTER_EXPIRY, estoque intacto', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      approve(paymentId, { dateLastUpdated: later() });

      await ctx.app.get(OrderExpirationService).run(later());

      expect(mp.cancelSpy).toHaveBeenCalledWith(paymentId);
      await expect(mp.cancelSpy.mock.results[0].value).rejects.toMatchObject({
        notCancellable: true,
      });
      expect(mp.getSpy).toHaveBeenCalledWith(paymentId);
      expect(await orderStatus(orderId)).toBe('EXPIRED');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'APPROVED',
        alert: 'PAID_AFTER_EXPIRY',
      });
    });

    it('pedido sem Pix ou com Pix já encerrado não chama o MP', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      await http()
        .post('/api/orders')
        .set('X-Forwarded-For', nextIp())
        .send({ items: [{ variantId: v.id, quantity: 1 }], customer })
        .expect(201);
      const rejected = await orderWithPix(v.id);
      await ctx.db
        .update(payments)
        .set({ status: 'REJECTED' })
        .where(eq(payments.orderId, rejected.orderId));

      await ctx.app.get(OrderExpirationService).run(later());

      expect(mp.cancelSpy).not.toHaveBeenCalled();
      expect(await stockOf(v.id)).toEqual({ stock: 3, reserved: 0 });
    });
  });

  describe('cancelamento do Pix quando o painel marca pago ou cancela (spec-019)', () => {
    const admin = () => ctx.app.get(AdminOrdersService);
    const FAILED = 'Não foi possível cancelar o Pix no Mercado Pago. Tente de novo.';

    /** Erro do PATCH de status como o painel o recebe (status HTTP e mensagem). */
    async function adminError(orderId: string, to: OrderStatus) {
      try {
        await admin().updateStatus(orderId, to);
      } catch (err) {
        if (err instanceof HttpException) return { status: err.getStatus(), message: err.message };
        throw err;
      }
      throw new Error('o painel deveria ter recusado a mudança');
    }

    async function chargesOf(orderId: string) {
      const rows = await ctx.db
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.orderId, orderId));
      return rows.map((r) => r.status).sort();
    }

    const leaksCustomer = () =>
      warnings().some((w) =>
        [customer.name, customer.email, customer.phone].some((c) => w.includes(c)),
      );

    it.each<[OrderStatus, { stock: number; reserved: number }]>([
      ['PAID', { stock: 1, reserved: 0 }],
      ['CANCELED', { stock: 2, reserved: 0 }],
    ])(
      '→ %s com Pix PENDING: cancela no MP antes de gravar; pagamento CANCELLED',
      async (to, stock) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const seenAtCancel: OrderStatus[] = [];
        const real = mp.cancelSpy.getMockImplementation()!;
        mp.cancelSpy.mockImplementation(async (id) => {
          // Outra conexão trava o pedido sem esperar (NOWAIT): nenhuma transação do painel está
          // aberta durante o PUT, e o pedido ainda não mudou.
          const [row] = await ctx.db
            .select({ status: orders.status })
            .from(orders)
            .where(eq(orders.id, orderId))
            .for('update', { noWait: true });
          seenAtCancel.push(row.status);
          return real(id);
        });

        const res = await admin().updateStatus(orderId, to);

        expect(res.status).toBe(to);
        expect(mp.cancelSpy).toHaveBeenCalledTimes(1);
        expect(mp.cancelSpy).toHaveBeenCalledWith(paymentId);
        expect(seenAtCancel).toEqual(['PENDING_PAYMENT']);
        expect((await paymentOf(orderId)).status).toBe('CANCELLED');
        expect(await orderStatus(orderId)).toBe(to);
        expect(await stockOf(v.id)).toEqual(stock);
        expect(await alertsOf(orderId)).toEqual([]);
      },
    );

    it.each<OrderStatus>(['PAID', 'CANCELED'])(
      '→ %s com falha no PUT: 502, nada muda, log com os ids e sem dados do cliente',
      async (to) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        mp.cancelSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago respondeu 500.'));

        expect(await adminError(orderId, to)).toEqual({ status: 502, message: FAILED });

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect((await paymentOf(orderId)).status).toBe('PENDING');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expect(warnings().some((w) => w.includes(paymentId) && w.includes(orderId))).toBe(true);
        expect(leaksCustomer()).toBe(false);

        // Com o Mercado Pago de volta, tentar de novo funciona.
        await admin().updateStatus(orderId, to);
        expect((await paymentOf(orderId)).status).toBe('CANCELLED');
        expect(await orderStatus(orderId)).toBe(to);
      },
    );

    it.each<OrderStatus>(['PAID', 'CANCELED'])(
      '→ %s quando o MP responde que o Pix já foi pago: pedido PAID pelo Pix, 409, sem DUPLICATE_PAYMENT',
      async (to) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        approve(paymentId);

        expect(await adminError(orderId, to)).toEqual({
          status: 409,
          message: 'Este pedido já foi pago pelo Pix.',
        });

        expect(mp.cancelSpy).toHaveBeenCalledTimes(1);
        // A order já paga não é cancelável: o estado real vem do GET (spec-021).
        await expect(mp.cancelSpy.mock.results[0].value).rejects.toMatchObject({
          notCancellable: true,
        });
        expect(mp.getSpy).toHaveBeenCalledWith(paymentId);
        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await paymentOf(orderId)).toMatchObject({ status: 'APPROVED', alert: null });
        expect(await alertsOf(orderId)).toEqual([]);
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
      },
    );

    it('PUT devolve a cobrança ainda pendente: 502 e nada muda', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      mp.cancelSpy.mockImplementationOnce(async (id) => ({ ...mp.remote.get(id)! }));

      expect(await adminError(orderId, 'PAID')).toEqual({ status: 502, message: FAILED });

      expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
      expect((await paymentOf(orderId)).status).toBe('PENDING');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
      expect(warnings().some((w) => w.includes(paymentId) && /continua pendente/.test(w))).toBe(
        true,
      );
    });

    it('pedido sem Pix ou com Pix já encerrado: não chama o MP; Marcar pago igual a hoje', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const res = await http()
        .post('/api/orders')
        .set('X-Forwarded-For', nextIp())
        .send({ items: [{ variantId: v.id, quantity: 1 }], customer })
        .expect(201);
      const rejected = await orderWithPix(v.id);
      await ctx.db
        .update(payments)
        .set({ status: 'REJECTED' })
        .where(eq(payments.orderId, rejected.orderId));

      await admin().updateStatus((res.body as { id: string }).id, 'PAID');
      await admin().updateStatus(rejected.orderId, 'PAID');

      expect(mp.cancelSpy).not.toHaveBeenCalled();
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
    });

    it('estresse: cliente paga (webhook) enquanto o painel marca pago: sempre 409, venda uma vez só, sem alerta', async () => {
      const ROUNDS = 6;
      const v = await variantWithStock('05-camiseta-preta', ROUNDS);
      const messages = new Set<string>();

      for (let round = 0; round < ROUNDS; round++) {
        const { orderId, paymentId } = await orderWithPix(v.id);
        approve(paymentId);
        // Conforme o escalonamento, o painel vê o Pix aprovado no PUT ("já pago pelo Pix"), vê o
        // pedido já PAID ao abrir a transação, ou perde o UPDATE condicional (status = de).
        const [hook, error] = await Promise.all([webhook(paymentId), adminError(orderId, 'PAID')]);

        expect(hook.status).toBe(200);
        expect(error.status).toBe(409);
        messages.add(error.message);
        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await paymentOf(orderId)).toMatchObject({ status: 'APPROVED', alert: null });
        expect(await alertsOf(orderId)).toEqual([]);
      }

      for (const message of messages) {
        expect(message).toMatch(/já foi pago pelo Pix|PAID → PAID|agora PAID/);
      }
      expect(await stockOf(v.id)).toEqual({ stock: 0, reserved: 0 });
    });

    it('intercalação 1, Pix gravado antes do commit do painel: 409, nada muda; tentar de novo cancela o novo', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId } = await orderWithPix(v.id);
      const transition = ctx.app.get(PaymentTransitionService);
      const realSync = transition.syncFrom.bind(transition);
      const spy = jest.spyOn(transition, 'syncFrom').mockImplementation(async (remote) => {
        const outcome = await realSync(remote);
        await http()
          .post(`/api/orders/${orderId}/pix`)
          .set('X-Forwarded-For', nextIp())
          .expect(201);
        return outcome;
      });

      expect(await adminError(orderId, 'PAID')).toEqual({
        status: 409,
        message:
          'Um novo Pix foi gerado para este pedido durante a operação. Recarregue e tente de novo.',
      });
      expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
      expect(await chargesOf(orderId)).toEqual(['CANCELLED', 'PENDING']);

      spy.mockRestore();
      await admin().updateStatus(orderId, 'PAID');
      expect(mp.cancelSpy).toHaveBeenCalledTimes(2);
      expect(await chargesOf(orderId)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
    });

    it.each<[OrderStatus, { stock: number; reserved: number }]>([
      ['PAID', { stock: 1, reserved: 0 }],
      ['CANCELED', { stock: 2, reserved: 0 }],
    ])(
      'intercalação 2, painel grava %s enquanto o MP cria o Pix: nada gravado, Pix cancelado no MP, ORDER_NOT_PAYABLE',
      async (to, stock) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const res = await http()
          .post('/api/orders')
          .set('X-Forwarded-For', nextIp())
          .send({ items: [{ variantId: v.id, quantity: 1 }], customer })
          .expect(201);
        const orderId = (res.body as { id: string }).id;
        const real = mp.createSpy.getMockImplementation()!;
        let createdId = '';
        mp.createSpy.mockImplementation(async (input) => {
          const created = await real(input);
          createdId = created.id;
          // Nenhuma trava do POST /pix fica aberta durante a chamada ao MP: o painel grava aqui.
          await admin().updateStatus(orderId, to);
          return created;
        });

        const pix = await http()
          .post(`/api/orders/${orderId}/pix`)
          .set('X-Forwarded-For', nextIp())
          .expect(409);

        expect(pix.body).toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
        expect(await chargesOf(orderId)).toEqual([]);
        expect(mp.cancelSpy).toHaveBeenCalledTimes(1);
        expect(mp.cancelSpy).toHaveBeenCalledWith(createdId);
        expect(mp.remote.get(createdId)?.status).toBe('canceled');
        expect(await orderStatus(orderId)).toBe(to);
        expect(await stockOf(v.id)).toEqual(stock);
      },
    );

    it('intercalação 2 com falha ao cancelar o Pix não gravado: só log, nada gravado, ORDER_NOT_PAYABLE', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const res = await http()
        .post('/api/orders')
        .set('X-Forwarded-For', nextIp())
        .send({ items: [{ variantId: v.id, quantity: 1 }], customer })
        .expect(201);
      const orderId = (res.body as { id: string }).id;
      const real = mp.createSpy.getMockImplementation()!;
      let createdId = '';
      mp.createSpy.mockImplementation(async (input) => {
        const created = await real(input);
        createdId = created.id;
        await admin().updateStatus(orderId, 'PAID');
        return created;
      });
      mp.cancelSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago respondeu 500.'));

      const pix = await http()
        .post(`/api/orders/${orderId}/pix`)
        .set('X-Forwarded-For', nextIp())
        .expect(409);

      expect(pix.body).toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
      expect(await chargesOf(orderId)).toEqual([]);
      expect(warnings().some((w) => w.includes(createdId) && w.includes(orderId))).toBe(true);
      expect(leaksCustomer()).toBe(false);
      expect(await orderStatus(orderId)).toBe('PAID');
    });

    it('pedido vence enquanto o MP cria o Pix: nada gravado, Pix cancelado no MP, ORDER_NOT_PAYABLE', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const res = await http()
        .post('/api/orders')
        .set('X-Forwarded-For', nextIp())
        .send({ items: [{ variantId: v.id, quantity: 1 }], customer })
        .expect(201);
      const orderId = (res.body as { id: string }).id;
      const real = mp.createSpy.getMockImplementation()!;
      mp.createSpy.mockImplementation(async (input) => {
        const created = await real(input);
        await ctx.db
          .update(orders)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(orders.id, orderId));
        return created;
      });

      await http().post(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp()).expect(409);

      expect(await chargesOf(orderId)).toEqual([]);
      expect(mp.cancelSpy).toHaveBeenCalledTimes(1);
      expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
    });

    it.each<[OrderStatus, 'DUPLICATE_PAYMENT' | 'PAID_AFTER_EXPIRY']>([
      ['PAID', 'DUPLICATE_PAYMENT'],
      ['CANCELED', 'PAID_AFTER_EXPIRY'],
    ])(
      'webhook approved atrasado de Pix já CANCELLED (pedido %s pelo painel): pedido e estoque não mudam, alerta %s',
      async (to, alert) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        await admin().updateStatus(orderId, to);
        expect((await paymentOf(orderId)).status).toBe('CANCELLED');
        const stock = await stockOf(v.id);
        // O MP não deveria aprovar um Pix cancelado; se aprovar, o syncFrom de hoje só alerta.
        approve(paymentId);

        await webhook(paymentId).expect(200);

        expect(await orderStatus(orderId)).toBe(to);
        expect(await stockOf(v.id)).toEqual(stock);
        expect(await paymentOf(orderId)).toMatchObject({ status: 'APPROVED', alert });
        expect(await alertsOf(orderId)).toEqual([alert]);
      },
    );
  });

  describe('order já cancelada no Mercado Pago (spec-021)', () => {
    it.each<OrderStatus>(['PAID', 'CANCELED'])(
      'painel → %s: order_already_canceled → GET → cobrança CANCELLED e o painel grava',
      async (to) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        // Cancelada do lado do MP (ex.: o expiration_time venceu) sem a loja ter visto.
        setRemote(paymentId, mpStatus.canceled);

        const res = await ctx.app.get(AdminOrdersService).updateStatus(orderId, to);

        expect(res.status).toBe(to);
        await expect(mp.cancelSpy.mock.results[0].value).rejects.toMatchObject({
          message: expect.stringMatching(/order_already_canceled/),
          notCancellable: true,
        });
        expect(mp.getSpy).toHaveBeenCalledWith(paymentId);
        expect((await paymentOf(orderId)).status).toBe('CANCELLED');
        expect(await orderStatus(orderId)).toBe(to);
        expect(await alertsOf(orderId)).toEqual([]);
      },
    );

    it('expiração: order_already_canceled → GET → cobrança CANCELLED, sem alerta', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      mp.cancelSpy.mockRejectedValueOnce(notCancellable('order_already_canceled'));
      setRemote(paymentId, mpStatus.expired);

      await ctx.app.get(OrderExpirationService).run(new Date(Date.now() + 31 * 60_000));

      expect(mp.getSpy).toHaveBeenCalledWith(paymentId);
      expect((await paymentOf(orderId)).status).toBe('CANCELLED');
      expect(await orderStatus(orderId)).toBe('EXPIRED');
      expect(await alertsOf(orderId)).toEqual([]);
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
    });

    it('recusa do cancelamento seguida de falha no GET: failed, 502 no painel, nada muda', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      mp.cancelSpy.mockRejectedValueOnce(notCancellable('invalid_order_status'));
      mp.getSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago respondeu 500.'));

      await expect(ctx.app.get(AdminOrdersService).updateStatus(orderId, 'PAID')).rejects.toThrow(
        /Não foi possível cancelar o Pix/,
      );

      expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
      expect((await paymentOf(orderId)).status).toBe('PENDING');
      expect(warnings().some((w) => w.includes(paymentId) && w.includes(orderId))).toBe(true);
    });
  });

  describe('estorno parcial visto antes da aprovação (spec-021)', () => {
    it('PENDING que o MP já mostra processed/partially_refunded: paga o pedido e alerta PAYMENT_REVERSED', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, { ...mpStatus.partiallyRefunded, dateLastUpdated: new Date() });

      await reconciliation.reconcile();

      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
      expect(await paymentOf(orderId)).toMatchObject({
        status: 'APPROVED',
        alert: 'PAYMENT_REVERSED',
      });
      expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
    });

    describe('formato real do MP (spec-030, prova de produção de 2026-11-08)', () => {
      /**
       * Estorno parcial como o MP de produção respondeu: `processed/partially_refunded` e
       * `total_paid_amount` igual ao total. O devolvido só vem em `transactions.refunds[]`, que o
       * cliente descarta (ver o unit de parse em mercadopago.client.spec.ts).
       */
      function realPartialRefund(paymentId: string) {
        const { amountCents } = mp.remote.get(paymentId)!;
        setRemote(paymentId, {
          ...mpStatus.partiallyRefunded,
          paidAmountCents: amountCents,
          dateLastUpdated: new Date(),
        });
      }

      it('1ª visão: pedido PAID, estoque baixa uma vez, cobrança APPROVED, só PAYMENT_REVERSED', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        realPartialRefund(paymentId);

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
        expect(await paymentOf(orderId)).toMatchObject({
          status: 'APPROVED',
          alert: 'PAYMENT_REVERSED',
        });
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      });

      it('cobrança já APPROVED: pedido segue PAID, estoque intacto, alerta PAYMENT_REVERSED', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const { amountCents } = mp.remote.get(paymentId)!;
        approve(paymentId, { paidAmountCents: amountCents });
        await reconciliation.reconcile();
        expect(await orderStatus(orderId)).toBe('PAID');
        const { approvedAt } = await paymentOf(orderId);

        realPartialRefund(paymentId);
        await checkedAgo(orderId, 7 * 3600);
        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
        expect(await paymentOf(orderId)).toMatchObject({
          status: 'APPROVED',
          alert: 'PAYMENT_REVERSED',
          approvedAt,
        });
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      });

      it('payments.updated_at muda quando um alerta novo é gravado, e não muda quando ele se repete', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const { amountCents } = mp.remote.get(paymentId)!;
        approve(paymentId, { paidAmountCents: amountCents });
        await reconciliation.reconcile();
        const approved = await paymentOf(orderId);
        expect(approved).toMatchObject({ status: 'APPROVED', alert: null });
        await sleep(20);

        realPartialRefund(paymentId);
        await checkedAgo(orderId, 7 * 3600);
        await reconciliation.reconcile();
        const reversed = await paymentOf(orderId);
        expect(reversed.alert).toBe('PAYMENT_REVERSED');
        expect(reversed.updatedAt.getTime()).toBeGreaterThan(approved.updatedAt.getTime());

        await sleep(20);
        await checkedAgo(orderId, 7 * 3600);
        await reconciliation.reconcile();
        expect((await paymentOf(orderId)).updatedAt).toEqual(reversed.updatedAt);
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      });
    });

    describe('valor pago no estorno parcial (spec-028; igualdade exata desde a spec-030)', () => {
      /**
       * Estorno parcial no formato real, com o valor pago igual ao total. Os casos de valor
       * diferente sobrescrevem `paidAmountCents`; são simulação.
       */
      function partialRefund(paymentId: string, over: Partial<ProviderPayment> = {}) {
        const { amountCents } = mp.remote.get(paymentId)!;
        setRemote(paymentId, {
          ...mpStatus.partiallyRefunded,
          paidAmountCents: amountCents,
          dateLastUpdated: new Date(),
          ...over,
        });
      }

      it('valor pago reduzido (simulação) reprova com AMOUNT_MISMATCH, sem pagar o pedido (spec-030)', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const { amountCents } = mp.remote.get(paymentId)!;
        partialRefund(paymentId, { paidAmountCents: amountCents - 100 });

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expect(await paymentOf(orderId)).toMatchObject({
          status: 'APPROVED',
          alert: 'AMOUNT_MISMATCH',
        });
        expect(await alertsOf(orderId)).toEqual(['AMOUNT_MISMATCH', 'PAYMENT_REVERSED']);
      });

      it('pedido expirado: PAID_AFTER_EXPIRY + PAYMENT_REVERSED, pedido e estoque intactos', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        // O cancelamento falha: a cobrança continua PENDING depois de o pedido expirar.
        mp.cancelSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago respondeu 500.'));
        await ctx.app.get(OrderExpirationService).run(new Date(Date.now() + 31 * 60_000));
        expect(await orderStatus(orderId)).toBe('EXPIRED');
        partialRefund(paymentId);

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('EXPIRED');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
        expect((await paymentOf(orderId)).status).toBe('APPROVED');
        expect(await alertsOf(orderId)).toEqual(['PAID_AFTER_EXPIRY', 'PAYMENT_REVERSED']);
      });

      it('pedido já pago: DUPLICATE_PAYMENT + PAYMENT_REVERSED, estoque baixa uma vez só', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        await ctx.app.get(AdminOrdersService).updateStatus(orderId, 'PAID');
        // Pago pelo painel antes da spec-019, quando o Pix ficava PENDING (hoje o painel o cancela).
        await ctx.db
          .update(payments)
          .set({ status: 'PENDING' })
          .where(eq(payments.orderId, orderId));
        partialRefund(paymentId);

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
        expect((await paymentOf(orderId)).status).toBe('APPROVED');
        expect(await alertsOf(orderId)).toEqual(['DUPLICATE_PAYMENT', 'PAYMENT_REVERSED']);
      });

      it('limite conhecido: last_updated_date depois do vencimento cai em PAID_AFTER_EXPIRY', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const [{ expiresAt }] = await ctx.db
          .select({ expiresAt: orders.expiresAt })
          .from(orders)
          .where(eq(orders.id, orderId));
        const refundedAt = new Date(expiresAt.getTime() + 60_000);
        partialRefund(paymentId, { dateLastUpdated: refundedAt });

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expect(await paymentOf(orderId)).toMatchObject({
          status: 'APPROVED',
          approvedAt: refundedAt,
        });
        expect(await alertsOf(orderId)).toEqual(['PAID_AFTER_EXPIRY', 'PAYMENT_REVERSED']);
      });

      it('total_paid_amount 0 reprova com AMOUNT_MISMATCH, sem pagar o pedido', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        partialRefund(paymentId, { paidAmountCents: 0 });

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expect(await paymentOf(orderId)).toMatchObject({
          status: 'APPROVED',
          alert: 'AMOUNT_MISMATCH',
        });
        expect(await alertsOf(orderId)).toEqual(['AMOUNT_MISMATCH', 'PAYMENT_REVERSED']);
      });

      it('total_paid_amount de 1 centavo reprova com AMOUNT_MISMATCH, sem pagar o pedido (spec-030)', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        partialRefund(paymentId, { paidAmountCents: 1 });

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expect(await alertsOf(orderId)).toEqual(['AMOUNT_MISMATCH', 'PAYMENT_REVERSED']);
      });

      it.each([
        ['nulo', () => null],
        ['igual ao total', (total: number) => total],
      ])('total_paid_amount %s continua pagando o pedido', async (_label, paid) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const { amountCents } = mp.remote.get(paymentId)!;
        partialRefund(paymentId, { paidAmountCents: paid(amountCents) });

        expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

        expect(await orderStatus(orderId)).toBe('PAID');
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
        expect(await alertsOf(orderId)).toEqual(['PAYMENT_REVERSED']);
      });

      it('valor pago acima do total em partially_refunded dá AMOUNT_MISMATCH, e o estorno também alerta (spec-028, spec-030)', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const { amountCents } = mp.remote.get(paymentId)!;
        partialRefund(paymentId, { paidAmountCents: amountCents + 1 });

        await reconciliation.reconcile();

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expect(await alertsOf(orderId)).toEqual(['AMOUNT_MISMATCH', 'PAYMENT_REVERSED']);
      });

      it.each([
        ['valor', { amountCents: 1 }],
        ['moeda', { currency: 'USD' }],
        ['referência', { externalReference: randomUUID() }],
      ])('%s divergente segue AMOUNT_MISMATCH', async (_label, over) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        partialRefund(paymentId, over);

        await reconciliation.reconcile();

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await alertsOf(orderId)).toEqual(['AMOUNT_MISMATCH', 'PAYMENT_REVERSED']);
      });

      it('accredited com valor pago reduzido segue AMOUNT_MISMATCH, sem PAYMENT_REVERSED', async () => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        const { amountCents } = mp.remote.get(paymentId)!;
        approve(paymentId, { paidAmountCents: amountCents - 100 });

        await reconciliation.reconcile();

        expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
        expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
        expect(await alertsOf(orderId)).toEqual(['AMOUNT_MISMATCH']);
      });
    });
  });

  describe('id antigo, de antes da API de Orders (spec-021, só no banco local)', () => {
    const LEGACY_ID = '5466310457';

    /** Pedido com Pix pendente cujo id no provedor é numérico, como os da API de Pagamentos. */
    async function orderWithLegacyPix(variantId: string) {
      const o = await orderWithPix(variantId);
      await ctx.db
        .update(payments)
        .set({ providerPaymentId: LEGACY_ID })
        .where(eq(payments.orderId, o.orderId));
      return { orderId: o.orderId, paymentRowId: (await paymentOf(o.orderId)).id };
    }

    it('conciliação pula: sem chamar o MP, sem contar falha, sem RECONCILIATION_STOPPED, um log e 24 h fora', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const { orderId, paymentRowId } = await orderWithLegacyPix(v.id);
      const healthy = await orderWithPix(v.id);
      approve(healthy.paymentId);
      const before = Date.now();

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      // Nas rodadas seguintes, mesmo sem o filtro dos 20 s, o id antigo fica fora por 24 h.
      for (let round = 0; round < RECONCILIATION_MAX_FAILURES; round++) {
        await checkedAgo(orderId, null);
        expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
      }

      expect(checkedIds()).toEqual([healthy.paymentId]);
      expect(await orderStatus(healthy.orderId)).toBe('PAID');
      const row = await paymentOf(orderId);
      expect(row).toMatchObject({ status: 'PENDING', checkFailures: 0, alert: null });
      const pause = row.nextCheckAt!.getTime() - before;
      expect(pause).toBeGreaterThan(LEGACY_ID_PAUSE_HOURS * 3600_000 - 60_000);
      expect(pause).toBeLessThan(LEGACY_ID_PAUSE_HOURS * 3600_000 + 60_000);
      expect(await alertsOf(orderId)).toEqual([]);
      const skipped = warnings().filter((w) => w.includes('pulada'));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain(paymentRowId);
      expect(skipped[0]).not.toContain(LEGACY_ID);
      for (const w of warnings()) {
        expect(w).not.toContain(customer.email);
        expect(w).not.toContain(customer.name);
      }
    });

    it(`${RECONCILIATION_BATCH} ou mais ids antigos não ocupam o lote no lugar de um pagamento válido`, async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const healthy = await orderWithPix(v.id);
      // Conferido há 1 min: sem a prioridade, os ids antigos nunca conferidos viriam antes dele.
      await checkedAgo(healthy.orderId, 60);
      approve(healthy.paymentId);
      const at = new Date(Date.now() - 86_400_000);
      await ctx.db.insert(payments).values(
        Array.from({ length: RECONCILIATION_BATCH + 5 }, (_, i) => ({
          orderId: healthy.orderId,
          providerPaymentId: String(4_000_000 + i),
          status: 'APPROVED' as const,
          amountCents: 100,
          expiresAt: at,
          approvedAt: at,
          createdAt: at,
        })),
      );

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      expect(checkedIds()).toEqual([healthy.paymentId]);
      expect(await orderStatus(healthy.orderId)).toBe('PAID');
      // As vagas que sobraram no lote foram para ids antigos, pulados e estacionados.
      expect(warnings().filter((w) => w.includes('pulada'))).toHaveLength(RECONCILIATION_BATCH - 1);
    });

    it('verificação sob demanda pula: sem chamar o MP e sem erro para a loja', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentRowId } = await orderWithLegacyPix(v.id);
      await checkedAgo(orderId, null);

      const res = await http()
        .get(`/api/orders/${orderId}/pix`)
        .set('X-Forwarded-For', nextIp())
        .expect(200);

      expect(res.body).toMatchObject({ status: 'PENDING', orderStatus: 'PENDING_PAYMENT' });
      expect(mp.getSpy).not.toHaveBeenCalled();
      expect((await paymentOf(orderId)).checkFailures).toBe(0);
      expect(warnings().some((w) => w.includes(paymentRowId) && w.includes('pulada'))).toBe(true);
    });
  });

  describe('limite de requisições', () => {
    it('webhook aceita 600 requisições por minuto do mesmo IP (a 601ª é 429); outra rota continua em 120/min', async () => {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 600; i++) {
        const res = await http()
          .post('/api/webhooks/mercadopago?data.id=1&type=payment')
          .set('X-Forwarded-For', ip)
          .send({ type: 'payment', data: { id: '1' } });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429)).toEqual([]);
      expect(new Set(statuses)).toEqual(new Set([401]));
      await http()
        .post('/api/webhooks/mercadopago?data.id=1&type=payment')
        .set('X-Forwarded-For', ip)
        .send({ type: 'payment', data: { id: '1' } })
        .expect(429);

      const other = nextIp();
      const missing = '00000000-0000-4000-8000-000000000000';
      for (let i = 0; i < 120; i++) {
        await http().get(`/api/orders/${missing}/pix`).set('X-Forwarded-For', other).expect(404);
      }
      await http().get(`/api/orders/${missing}/pix`).set('X-Forwarded-For', other).expect(429);
    });
  });
});

describe('migrações 0005 (histórico de alertas) e 0006 (backoff da conciliação)', () => {
  const SCRATCH_DB = 'otilc_test_migration_0005';
  const scratchUrl = () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${SCRATCH_DB}`;
    return url.toString();
  };
  const drizzleDir = path.join(__dirname, '..', 'drizzle');

  /** Pasta de migrações só até a `last`: o estado do banco antes da spec que veio depois. */
  function migrationsUpTo(last: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'otilc-mig-'));
    cpSync(drizzleDir, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    for (const e of journal.entries.filter((entry) => entry.idx > last)) {
      rmSync(path.join(dir, `${e.tag}.sql`));
      rmSync(path.join(dir, 'meta', `${e.tag.slice(0, 4)}_snapshot.json`));
    }
    journal.entries = journal.entries.filter((e) => e.idx <= last);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  async function insertOrder(db: ReturnType<typeof createDatabase>['db']) {
    const [order] = await db
      .insert(orders)
      .values({
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        totalCents: 1000,
        expiresAt: new Date(),
      })
      .returning({ id: orders.id });
    return order;
  }

  async function recreateScratch() {
    const { db, pool } = createDatabase(TEST_DATABASE_URL);
    try {
      await db.execute(sql`DROP DATABASE IF EXISTS ${sql.identifier(SCRATCH_DB)}`);
      await db.execute(sql`CREATE DATABASE ${sql.identifier(SCRATCH_DB)}`);
    } finally {
      await pool.end();
    }
  }

  afterAll(async () => {
    const { db, pool } = createDatabase(TEST_DATABASE_URL);
    try {
      await db.execute(sql`DROP DATABASE IF EXISTS ${sql.identifier(SCRATCH_DB)}`);
    } finally {
      await pool.end();
    }
  });

  it('copia os payments.alert existentes para payment_alerts, com RLS habilitado', async () => {
    await recreateScratch();
    const dir = migrationsUpTo(4);
    const { db, pool } = createDatabase(scratchUrl());
    try {
      await migrate(db, { migrationsFolder: dir });
      const [order] = await db
        .insert(orders)
        .values({
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          totalCents: 1000,
          expiresAt: new Date(),
        })
        .returning({ id: orders.id });
      // Em SQL: o insert do Drizzle cita todas as colunas do schema.ts, inclusive as da 0006.
      await db.execute(sql`
        INSERT INTO payments (order_id, provider_payment_id, status, amount_cents, expires_at, alert)
        VALUES
          (${order.id}, '1', 'APPROVED', 1000, now(), 'PAID_AFTER_EXPIRY'),
          (${order.id}, '2', 'APPROVED', 1000, now(), 'AMOUNT_MISMATCH'),
          (${order.id}, '3', 'APPROVED', 1000, now(), NULL)
      `);

      await runMigrations(scratchUrl());

      const rows = await db
        .select({ providerPaymentId: payments.providerPaymentId, alert: paymentAlerts.alert })
        .from(paymentAlerts)
        .innerJoin(payments, eq(payments.id, paymentAlerts.paymentId))
        .where(inArray(payments.providerPaymentId, ['1', '2', '3']))
        .orderBy(payments.providerPaymentId);
      expect(rows).toEqual([
        { providerPaymentId: '1', alert: 'PAID_AFTER_EXPIRY' },
        { providerPaymentId: '2', alert: 'AMOUNT_MISMATCH' },
      ]);
      const kept = await db
        .select({ alert: payments.alert })
        .from(payments)
        .orderBy(payments.providerPaymentId);
      expect(kept.map((p) => p.alert)).toEqual(['PAID_AFTER_EXPIRY', 'AMOUNT_MISMATCH', null]);
      const { rows: rls } = await db.execute<{ rls: boolean }>(
        sql`SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'payment_alerts'`,
      );
      expect(rls).toEqual([{ rls: true }]);
    } finally {
      await pool.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('0006 sobre um banco com a 0005: payments existentes ficam com 0 falhas e sem próxima consulta', async () => {
    await recreateScratch();
    const dir = migrationsUpTo(5);
    const { db, pool } = createDatabase(scratchUrl());
    try {
      await migrate(db, { migrationsFolder: dir });
      const order = await insertOrder(db);
      await db.execute(sql`
        INSERT INTO payments (order_id, provider_payment_id, status, amount_cents, expires_at)
        VALUES (${order.id}, '1', 'PENDING', 1000, now()), (${order.id}, '2', 'APPROVED', 1000, now())
      `);

      await runMigrations(scratchUrl());

      const rows = await db
        .select({ checkFailures: payments.checkFailures, nextCheckAt: payments.nextCheckAt })
        .from(payments)
        .orderBy(payments.providerPaymentId);
      expect(rows).toEqual([
        { checkFailures: 0, nextCheckAt: null },
        { checkFailures: 0, nextCheckAt: null },
      ]);
      // O valor novo do enum é usável depois do commit da migração.
      const [first] = await db.select({ id: payments.id }).from(payments).limit(1);
      await db
        .insert(paymentAlerts)
        .values({ paymentId: first.id, alert: 'RECONCILIATION_STOPPED' });
      await expect(
        db.update(payments).set({ checkFailures: -1 }).where(eq(payments.id, first.id)),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'payments_check_failures_non_negative' },
      });
    } finally {
      await pool.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('0007 sobre um banco com a 0006: alertas existentes ficam abertos; CHECK e FK de resolved_by', async () => {
    await recreateScratch();
    const dir = migrationsUpTo(6);
    const { db, pool } = createDatabase(scratchUrl());
    try {
      await migrate(db, { migrationsFolder: dir });
      const order = await insertOrder(db);
      // Em SQL: o insert do Drizzle cita as colunas da 0007, que ainda não existem.
      await db.execute(sql`
        INSERT INTO payments (order_id, provider_payment_id, status, amount_cents, expires_at)
        VALUES (${order.id}, '1', 'APPROVED', 1000, now())
      `);
      await db.execute(sql`
        INSERT INTO payment_alerts (payment_id, alert)
        SELECT id, 'PAID_AFTER_EXPIRY' FROM payments WHERE provider_payment_id = '1'
      `);

      await runMigrations(scratchUrl());

      const [alert] = await db.select().from(paymentAlerts);
      expect(alert).toMatchObject({
        alert: 'PAID_AFTER_EXPIRY',
        resolvedAt: null,
        resolvedBy: null,
      });
      const { rows: index } = await db.execute<{ def: string }>(
        sql`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'payment_alerts_open_created_idx'`,
      );
      expect(index).toHaveLength(1);
      expect(index[0].def).toContain('WHERE (resolved_at IS NULL)');

      await expect(
        db
          .update(paymentAlerts)
          .set({ resolvedBy: randomUUID() })
          .where(eq(paymentAlerts.id, alert.id)),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'payment_alerts_resolved_by_needs_resolved_at' },
      });
      await expect(
        db
          .update(paymentAlerts)
          .set({ resolvedAt: new Date(), resolvedBy: randomUUID() })
          .where(eq(paymentAlerts.id, alert.id)),
      ).rejects.toMatchObject({ cause: { code: '23503' } });

      // Admin removido: a resolução continua, sem o autor.
      const { rows: admins } = await db.execute<{ id: string }>(sql`
        INSERT INTO admin_users (email, name, password_hash, role)
        VALUES ('dono@example.test', 'Dono', 'teste-hash-ficticio', 'OWNER') RETURNING id
      `);
      await db
        .update(paymentAlerts)
        .set({ resolvedAt: new Date(), resolvedBy: admins[0].id })
        .where(eq(paymentAlerts.id, alert.id));
      await db.execute(sql`DELETE FROM admin_users WHERE id = ${admins[0].id}`);
      const [after] = await db.select().from(paymentAlerts);
      expect(after.resolvedAt).not.toBeNull();
      expect(after.resolvedBy).toBeNull();
    } finally {
      await pool.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('banco limpo: db:migrate aplica da 0000 à 0007 de uma vez e o alerta novo é gravável', async () => {
    await recreateScratch();
    await runMigrations(scratchUrl());
    const { db, pool } = createDatabase(scratchUrl());
    try {
      const { rows: applied } = await db.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM drizzle.__drizzle_migrations`,
      );
      expect(applied).toEqual([{ total: 8 }]);
      const order = await insertOrder(db);
      const [payment] = await db
        .insert(payments)
        .values({
          orderId: order.id,
          providerPaymentId: '1',
          status: 'PENDING',
          amountCents: 1000,
          expiresAt: new Date(),
        })
        .returning({ id: payments.id, checkFailures: payments.checkFailures });
      expect(payment.checkFailures).toBe(0);
      await db
        .insert(paymentAlerts)
        .values({ paymentId: payment.id, alert: 'RECONCILIATION_STOPPED' });
      const alerts = await db.select({ alert: paymentAlerts.alert }).from(paymentAlerts);
      expect(alerts).toEqual([{ alert: 'RECONCILIATION_STOPPED' }]);
    } finally {
      await pool.end();
    }
  });
});
