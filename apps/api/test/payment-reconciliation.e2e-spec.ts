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
  PaymentReconciliationService,
  RECONCILIATION_BATCH,
} from '../src/payments/payment-reconciliation.service';
import { PaymentTransitionService } from '../src/payments/payment-transition.service';
import { mockMercadoPago, setupPixTestApp, signature, type MercadoPagoMock } from './pix-setup';
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
    setRemote(id, { status: 'approved', dateApproved: new Date(), ...over });

  /** Faz o pagamento parecer conferido há `secondsAgo` segundos (null: nunca conferido). */
  async function checkedAgo(orderId: string, secondsAgo: number | null) {
    await ctx.db
      .update(payments)
      .set({ lastCheckedAt: secondsAgo === null ? null : new Date(Date.now() - secondsAgo * 1000) })
      .where(eq(payments.orderId, orderId));
  }

  const checkedIds = () => mp.getSpy.mock.calls.map((c) => c[0]).sort();
  const warnings = () => warn.mock.calls.map((c) => String(c[0]));

  function webhook(dataId: string) {
    const requestId = randomUUID();
    return http()
      .post(`/api/webhooks/mercadopago?data.id=${dataId}&type=payment`)
      .set('X-Forwarded-For', nextIp())
      .set('x-request-id', requestId)
      .set('x-signature', signature(dataId, requestId))
      .send({ type: 'payment', action: 'payment.updated', data: { id: dataId } });
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

    it.each(['cancelled', 'rejected'])(
      'MP %s → payments.status atualizado, pedido não muda',
      async (status) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { orderId, paymentId } = await orderWithPix(v.id);
        setRemote(paymentId, { status });

        await reconciliation.reconcile();

        expect((await paymentOf(orderId)).status).toBe(status.toUpperCase());
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
        approve(o.paymentId, { dateApproved: at });
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
      const ids = Array.from({ length: total }, (_, i) => String(2_000_000 + i));
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
          status: 'approved',
          externalReference: orderId,
          amountCents: 100,
          currency: 'BRL',
          dateApproved: at,
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

      // Sem ajuste manual: a falha devolveu o last_checked_at anterior.
      mp.getSpy.mockImplementation(real);
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
      setRemote(paymentId, { status: 'charged_back' });
      mp.getSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago indisponível (rede).'));

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
      expect((await paymentOf(orderId)).lastCheckedAt).toEqual(before);

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

  describe('status nunca regride', () => {
    it('cancelled ou rejected atrasado sobre APPROVED ou REFUNDED não muda nada', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const approvedOrder = await orderWithPix(v.id);
      const refundedOrder = await orderWithPix(v.id);
      for (const o of [approvedOrder, refundedOrder]) approve(o.paymentId);
      await reconciliation.reconcile();
      setRemote(refundedOrder.paymentId, { status: 'refunded' });
      await webhook(refundedOrder.paymentId).expect(200);
      const approvedRow = await paymentOf(approvedOrder.orderId);
      const refundedRow = await paymentOf(refundedOrder.orderId);
      expect(refundedRow.status).toBe('REFUNDED');

      for (const late of ['cancelled', 'rejected']) {
        setRemote(approvedOrder.paymentId, { status: late });
        setRemote(refundedOrder.paymentId, { status: late });
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
      setRemote(neverPaid.paymentId, { status: 'refunded' });
      const paid = await orderWithPix(v.id);
      approve(paid.paymentId);
      await reconciliation.reconcile();
      setRemote(paid.paymentId, { status: 'refunded' });
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
      expect(await alertsOf(neverPaid.orderId)).toEqual([]);
      expect(await alertsOf(paid.orderId)).toEqual(['PAYMENT_REVERSED']);
      // Uma unidade vendida (paid) e uma ainda reservada (neverPaid, que segue a própria expiração).
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
    });

    it('PENDING que o MP já mostra refunded vira REFUNDED, sem alerta, com warn', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      setRemote(paymentId, { status: 'refunded' });

      await reconciliation.reconcile();

      expect(await paymentOf(orderId)).toMatchObject({ status: 'REFUNDED', alert: null });
      expect(await alertsOf(orderId)).toEqual([]);
      expect(await orderStatus(orderId)).toBe('PENDING_PAYMENT');
      expect(warnings()).toContainEqual(
        expect.stringMatching(/estornado antes de ser visto aprovado/),
      );
      const logged = warnings().find((w) => w.includes('estornado antes'))!;
      expect(logged).toContain(paymentId);
      expect(logged).toContain(orderId);
    });
  });

  describe('estorno ou contestação depois de pago (PAYMENT_REVERSED)', () => {
    it.each([
      ['refunded', 'REFUNDED'],
      ['charged_back', 'APPROVED'],
      ['in_mediation', 'APPROVED'],
    ])(
      'MP %s → alerta, cobrança %s, pedido e estoque intactos; repetir não grava nada',
      async (status, local) => {
        const v = await variantWithStock('05-camiseta-preta', 3);
        const { orderId, paymentId } = await orderWithPix(v.id);
        approve(paymentId);
        await reconciliation.reconcile();
        expect(await orderStatus(orderId)).toBe('PAID');

        setRemote(paymentId, { status });
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

      setRemote(paymentId, { status: 'refunded' });
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

  describe('aprovação sem date_approved', () => {
    it('usa date_last_updated, com warn', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      const expiresAt = new Date(Date.now() - 60_000);
      await ctx.db.update(orders).set({ expiresAt }).where(eq(orders.id, orderId));
      const lastUpdated = new Date(expiresAt.getTime() - 5000);
      approve(paymentId, { dateApproved: null, dateLastUpdated: lastUpdated });

      await reconciliation.reconcile();

      // Pago dentro do prazo pela data do Mercado Pago, não pela hora da conciliação.
      expect(await orderStatus(orderId)).toBe('PAID');
      expect((await paymentOf(orderId)).approvedAt).toEqual(lastUpdated);
      expect(warnings()).toContainEqual(expect.stringMatching(/date_last_updated/));
    });

    it('sem as duas datas, usa a hora atual, com warn', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      await ctx.db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(orders.id, orderId));
      approve(paymentId, { dateApproved: null, dateLastUpdated: null });
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

      setRemote(paymentId, { status: 'cancelled' });
      await reconciliation.reconcile();
      expect((await paymentOf(orderId)).status).toBe('CANCELLED');
    });

    it('MP responde que o Pix já foi aprovado → PAID_AFTER_EXPIRY, estoque intacto', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { orderId, paymentId } = await orderWithPix(v.id);
      approve(paymentId, { dateApproved: later() });

      await ctx.app.get(OrderExpirationService).run(later());

      expect(mp.cancelSpy).toHaveBeenCalledWith(paymentId);
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
        expect(mp.remote.get(createdId)?.status).toBe('cancelled');
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

describe('migração 0005: histórico de alertas', () => {
  const SCRATCH_DB = 'otilc_test_migration_0005';
  const scratchUrl = () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${SCRATCH_DB}`;
    return url.toString();
  };
  const drizzleDir = path.join(__dirname, '..', 'drizzle');

  /** Pasta de migrações só até a 0004: o estado do banco antes desta spec. */
  function migrationsUpTo0004(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'otilc-mig-'));
    cpSync(drizzleDir, dir, { recursive: true });
    rmSync(path.join(dir, '0005_reconciliation_alerts.sql'));
    rmSync(path.join(dir, 'meta', '0005_snapshot.json'));
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((e) => e.idx <= 4);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
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
    const dir = migrationsUpTo0004();
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
      const base = { orderId: order.id, amountCents: 1000, expiresAt: new Date() };
      await db.insert(payments).values([
        { ...base, providerPaymentId: '1', status: 'APPROVED', alert: 'PAID_AFTER_EXPIRY' },
        { ...base, providerPaymentId: '2', status: 'APPROVED', alert: 'AMOUNT_MISMATCH' },
        { ...base, providerPaymentId: '3', status: 'APPROVED' },
      ]);

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
});
