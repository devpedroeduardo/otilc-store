import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { AdminAlertDto, AdminRole, PaymentAlertType } from '@otilc/shared';
import { AdminAuthService } from '../src/admin-auth/admin-auth.service';
import { createAdminUser } from '../src/admin-auth/new-admin';
import { SESSION_COOKIE } from '../src/admin-auth/session-token';
import { adminUsers, orders, paymentAlerts, payments, products, variants } from '../src/db/schema';
import { PIX_PROVIDER, type MercadoPagoClient } from '../src/payments/mercadopago.client';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service';
import { PaymentTransitionService } from '../src/payments/payment-transition.service';
import { RECONCILIATION_MAX_FAILURES } from '../src/payments/reconciliation-backoff';
import {
  mockMercadoPago,
  mpStatus,
  setupPixTestApp,
  signature,
  type MercadoPagoMock,
} from './pix-setup';
import { resetData, teardownTestApp, type TestContext } from './setup';

const WEB_ORIGIN = 'http://localhost:3000';
const PASSWORD = randomBytes(24).toString('base64url');
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const customer = { name: 'Caio Prado', email: 'caio@example.com', phone: '+5585999990002' };

describe('Admin: painel de alertas de pagamento (integração com Postgres)', () => {
  let ctx: TestContext;
  let mp: MercadoPagoMock;
  let reconciliation: PaymentReconciliationService;
  let warn: jest.SpyInstance;
  let staff: string;
  let staffId: string;
  let ipCounter = 0;
  const nextIp = () => `10.80.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await setupPixTestApp();
    reconciliation = ctx.app.get(PaymentReconciliationService);
  });
  beforeEach(async () => {
    await resetData(ctx.db);
    await ctx.db.execute(sql`TRUNCATE payment_notifications`);
    mp = mockMercadoPago(ctx.app.get<MercadoPagoClient>(PIX_PROVIDER));
    warn = jest.spyOn(Logger.prototype, 'warn');
    ({ cookie: staff, id: staffId } = await session('STAFF'));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => teardownTestApp(ctx));

  /** Cria o admin e a sessão direto pelo serviço (sem passar pelo limite de login). */
  async function session(role: AdminRole): Promise<{ cookie: string; id: string }> {
    const email = `${role.toLowerCase()}@example.test`;
    const user = await createAdminUser(ctx.db, {
      email,
      name: `Admin ${role}`,
      role,
      password: PASSWORD,
    });
    const { token } = await ctx.app.get(AdminAuthService).login({ email, password: PASSWORD });
    return { cookie: `${SESSION_COOKIE}=${token}`, id: user.id };
  }

  const http = () => request(ctx.app.getHttpServer());
  const list = (query = '', cookie = staff) =>
    http().get(`/api/admin/alerts${query}`).set('Cookie', cookie).set('X-Forwarded-For', nextIp());
  const post = (id: string, action: 'resolve' | 'resume-reconciliation', cookie = staff) =>
    http()
      .post(`/api/admin/alerts/${id}/${action}`)
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .set('X-Forwarded-For', nextIp());

  async function variantWithStock(stock: number) {
    const product = await ctx.db.query.products.findFirst({
      where: eq(products.slug, '05-camiseta-preta'),
      with: { variants: true },
    });
    if (!product) throw new Error('produto ausente na seed');
    const [v] = product.variants;
    await ctx.db.update(variants).set({ stock }).where(eq(variants.id, v.id));
    return v;
  }

  /** Pedido com Pix pendente criado há 5 min (dentro da janela da conciliação). */
  async function orderWithPix(variantId: string) {
    const res = await http()
      .post('/api/orders')
      .set('X-Forwarded-For', nextIp())
      .send({ items: [{ variantId, quantity: 1 }], customer })
      .expect(201);
    const orderId = (res.body as { id: string }).id;
    await http().post(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp()).expect(201);
    await ctx.db
      .update(payments)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(payments.orderId, orderId));
    const payment = await paymentOf(orderId);
    return { orderId, payment, providerPaymentId: payment.providerPaymentId };
  }

  async function paymentOf(orderId: string) {
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, orderId));
    return row;
  }

  async function alertRow(id: string) {
    const [row] = await ctx.db.select().from(paymentAlerts).where(eq(paymentAlerts.id, id));
    return row;
  }

  async function alertsOfPayment(paymentId: string) {
    return ctx.db.select().from(paymentAlerts).where(eq(paymentAlerts.paymentId, paymentId));
  }

  /** Alerta gravado direto, criado há `minutesAgo` minutos. */
  async function insertAlert(paymentId: string, alert: PaymentAlertType, minutesAgo = 0) {
    const [row] = await ctx.db
      .insert(paymentAlerts)
      .values({ paymentId, alert, createdAt: new Date(Date.now() - minutesAgo * 60_000) })
      .returning({ id: paymentAlerts.id });
    return row.id;
  }

  /** Pagamento no teto de falhas da conciliação, com o alerta RECONCILIATION_STOPPED. */
  async function stoppedPayment() {
    const v = await variantWithStock(3);
    const pix = await orderWithPix(v.id);
    await ctx.db
      .update(payments)
      .set({ checkFailures: RECONCILIATION_MAX_FAILURES, nextCheckAt: null, lastCheckedAt: null })
      .where(eq(payments.id, pix.payment.id));
    const alertId = await insertAlert(pix.payment.id, 'RECONCILIATION_STOPPED');
    return { ...pix, payment: await paymentOf(pix.orderId), alertId };
  }

  function webhook(dataId: string) {
    const requestId = randomUUID();
    return http()
      .post(`/api/webhooks/mercadopago?data.id=${dataId}&type=order`)
      .set('X-Forwarded-For', nextIp())
      .set('x-request-id', requestId)
      .set('x-signature', signature(dataId, requestId))
      .send({ type: 'order', action: 'order.processed', data: { id: dataId } });
  }

  const alertWarnings = (providerPaymentId: string, alert: PaymentAlertType) =>
    warn.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes(providerPaymentId) && w.includes(`alerta ${alert}`));

  async function backoffElapsed(paymentId: string) {
    await ctx.db
      .update(payments)
      .set({ nextCheckAt: new Date(Date.now() - 1000) })
      .where(eq(payments.id, paymentId));
  }

  /** Rodadas com o backoff vencido até a conciliação parar no teto. */
  async function failUntilStopped(paymentId: string) {
    for (let n = 1; n <= RECONCILIATION_MAX_FAILURES; n++) {
      await backoffElapsed(paymentId);
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 1 });
    }
    const [row] = await ctx.db.select().from(payments).where(eq(payments.id, paymentId));
    expect(row.checkFailures).toBe(RECONCILIATION_MAX_FAILURES);
  }

  describe('acesso', () => {
    it('401 sem sessão nas 3 rotas', async () => {
      await http().get('/api/admin/alerts').set('X-Forwarded-For', nextIp()).expect(401);
      for (const action of ['resolve', 'resume-reconciliation']) {
        await http()
          .post(`/api/admin/alerts/${MISSING_ID}/${action}`)
          .set('Origin', WEB_ORIGIN)
          .set('X-Forwarded-For', nextIp())
          .expect(401);
      }
    });

    it('mutação sem Origin (ou de outra origem) → 403, antes de tocar no alerta', async () => {
      const { alertId, orderId } = await stoppedPayment();
      for (const action of ['resolve', 'resume-reconciliation']) {
        await http()
          .post(`/api/admin/alerts/${alertId}/${action}`)
          .set('Cookie', staff)
          .set('X-Forwarded-For', nextIp())
          .expect(403);
        await http()
          .post(`/api/admin/alerts/${alertId}/${action}`)
          .set('Cookie', staff)
          .set('Origin', 'https://evil.example.com')
          .set('X-Forwarded-For', nextIp())
          .expect(403);
      }
      expect((await alertRow(alertId)).resolvedAt).toBeNull();
      expect((await paymentOf(orderId)).checkFailures).toBe(RECONCILIATION_MAX_FAILURES);
    });

    it('400 com query ou id inválidos; 404 com id inexistente', async () => {
      for (const query of ['?situacao=abertas', '?tipo=OUTRO', '?pagina=0', '?porPagina=101']) {
        await list(query).expect(400);
      }
      await post('nao-e-uuid', 'resolve').expect(400);
      await post('nao-e-uuid', 'resume-reconciliation').expect(400);
      await post(MISSING_ID, 'resolve').expect(404);
      await post(MISSING_ID, 'resume-reconciliation').expect(404);
    });
  });

  describe('lista', () => {
    it('padrão abertos, do mais novo ao mais antigo, com pagamento e pedido; filtra por situação e tipo', async () => {
      const v = await variantWithStock(5);
      const a = await orderWithPix(v.id);
      const b = await orderWithPix(v.id);
      const oldest = await insertAlert(a.payment.id, 'PAID_AFTER_EXPIRY', 30);
      const newest = await insertAlert(b.payment.id, 'DUPLICATE_PAYMENT', 10);
      const middle = await insertAlert(a.payment.id, 'PAYMENT_REVERSED', 20);
      const resolved = await insertAlert(b.payment.id, 'AMOUNT_MISMATCH', 5);
      await ctx.db
        .update(paymentAlerts)
        .set({ resolvedAt: new Date(), resolvedBy: staffId })
        .where(eq(paymentAlerts.id, resolved));
      const [orderA] = await ctx.db.select().from(orders).where(eq(orders.id, a.orderId));

      const res = await list().expect(200);
      expect(res.body).toMatchObject({ page: 1, perPage: 20, total: 3, totalPages: 1 });
      const items = res.body.items as AdminAlertDto[];
      expect(items.map((i) => i.id)).toEqual([newest, middle, oldest]);
      expect(items[2]).toEqual({
        id: oldest,
        type: 'PAID_AFTER_EXPIRY',
        createdAt: expect.any(String),
        resolvedAt: null,
        resolvedBy: null,
        payment: {
          id: a.payment.id,
          providerPaymentId: a.providerPaymentId,
          status: 'PENDING',
          amountCents: a.payment.amountCents,
        },
        order: { id: a.orderId, number: orderA.number, status: 'PENDING_PAYMENT' },
      });
      // Nada de dados do cliente além do que a lista de pedidos mostra.
      expect(JSON.stringify(res.body)).not.toContain(customer.email);
      expect(JSON.stringify(res.body)).not.toContain(customer.phone);

      const done = await list('?situacao=resolvidos').expect(200);
      expect(done.body.items).toEqual([
        expect.objectContaining({
          id: resolved,
          type: 'AMOUNT_MISMATCH',
          resolvedAt: expect.any(String),
          resolvedBy: 'Admin STAFF',
        }),
      ]);
      const all = await list('?situacao=todos').expect(200);
      expect((all.body.items as AdminAlertDto[]).map((i) => i.id)).toEqual([
        resolved,
        newest,
        middle,
        oldest,
      ]);
      const reversed = await list('?situacao=todos&tipo=PAYMENT_REVERSED').expect(200);
      expect((reversed.body.items as AdminAlertDto[]).map((i) => i.id)).toEqual([middle]);
      expect((await list('?tipo=AMOUNT_MISMATCH').expect(200)).body.total).toBe(0);
    });

    it('pagina com porPagina e pagina', async () => {
      const v = await variantWithStock(2);
      const { payment } = await orderWithPix(v.id);
      const types: PaymentAlertType[] = [
        'PAID_AFTER_EXPIRY',
        'AMOUNT_MISMATCH',
        'DUPLICATE_PAYMENT',
        'PAYMENT_REVERSED',
        'RECONCILIATION_STOPPED',
      ];
      const ids: string[] = [];
      for (const [i, type] of types.entries())
        ids.push(await insertAlert(payment.id, type, 50 - i));
      const newestFirst = [...ids].reverse();

      const page2 = await list('?pagina=2&porPagina=2').expect(200);
      expect(page2.body).toMatchObject({ page: 2, perPage: 2, total: 5, totalPages: 3 });
      expect((page2.body.items as AdminAlertDto[]).map((i) => i.id)).toEqual(
        newestFirst.slice(2, 4),
      );
      const page3 = await list('?pagina=3&porPagina=2').expect(200);
      expect((page3.body.items as AdminAlertDto[]).map((i) => i.id)).toEqual(newestFirst.slice(4));
      const empty = await list('?pagina=9&porPagina=2').expect(200);
      expect(empty.body).toMatchObject({ items: [], total: 5, totalPages: 3 });
    });

    it('admin que resolveu e foi removido: a resolução fica, sem o nome', async () => {
      const v = await variantWithStock(2);
      const { payment } = await orderWithPix(v.id);
      const id = await insertAlert(payment.id, 'DUPLICATE_PAYMENT');
      const owner = await session('OWNER');
      await post(id, 'resolve', owner.cookie).expect(200);
      await ctx.db.execute(sql`DELETE FROM admin_sessions WHERE user_id = ${owner.id}`);
      await ctx.db.delete(adminUsers).where(eq(adminUsers.id, owner.id));

      const res = await list('?situacao=resolvidos').expect(200);
      expect(res.body.items).toEqual([
        expect.objectContaining({ id, resolvedAt: expect.any(String), resolvedBy: null }),
      ]);
    });
  });

  describe('marcar resolvido', () => {
    it('grava resolved_at e resolved_by e devolve o item; o segundo resolve é 409', async () => {
      const v = await variantWithStock(2);
      const { payment } = await orderWithPix(v.id);
      const id = await insertAlert(payment.id, 'PAID_AFTER_EXPIRY');
      const before = await alertRow(id);

      const res = await post(id, 'resolve').expect(200);
      expect(res.body).toMatchObject({
        id,
        type: 'PAID_AFTER_EXPIRY',
        resolvedAt: expect.any(String),
        resolvedBy: 'Admin STAFF',
        payment: { id: payment.id },
      });
      const row = await alertRow(id);
      expect(row.resolvedBy).toBe(staffId);
      expect(row.resolvedAt).not.toBeNull();
      expect(row.createdAt).toEqual(before.createdAt);
      expect((await list().expect(200)).body.total).toBe(0);

      const again = await post(id, 'resolve').expect(409);
      expect(again.body).toMatchObject({ statusCode: 409, code: 'ALERT_ALREADY_RESOLVED' });
      expect(await alertRow(id)).toEqual(row);
    });

    it('dois resolves simultâneos: um 200 e um 409, e só um autor gravado', async () => {
      const v = await variantWithStock(2);
      const { payment } = await orderWithPix(v.id);
      const owner = await session('OWNER');
      for (let round = 0; round < 5; round++) {
        await ctx.db.delete(paymentAlerts);
        const id = await insertAlert(payment.id, 'DUPLICATE_PAYMENT');
        const results = await Promise.all([post(id, 'resolve'), post(id, 'resolve', owner.cookie)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const winner = results.find((r) => r.status === 200)!;
        const row = await alertRow(id);
        expect(row.resolvedBy).toBe(winner.body.resolvedBy === 'Admin STAFF' ? staffId : owner.id);
      }
    });

    it('resolver não muda pagamento, pedido nem payments.alert', async () => {
      const { alertId, payment, orderId } = await stoppedPayment();
      const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
      await post(alertId, 'resolve').expect(200);
      expect(await paymentOf(orderId)).toEqual(payment);
      expect(await ctx.db.select().from(orders).where(eq(orders.id, orderId))).toEqual([order]);
      // A conciliação continua parada: resolver não é retomar.
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });
    });
  });

  describe('retomar conciliação', () => {
    it('zera check_failures e next_check_at, sem consultar o MP; o alerta segue aberto e a conciliação volta a selecionar', async () => {
      const { alertId, orderId, payment } = await stoppedPayment();
      expect(await reconciliation.reconcile()).toEqual({ checked: 0, failed: 0 });

      const res = await post(alertId, 'resume-reconciliation').expect(200);
      expect(res.body).toMatchObject({ id: alertId, resolvedAt: null, resolvedBy: null });
      expect(mp.getSpy).not.toHaveBeenCalled();
      const after = await paymentOf(orderId);
      expect(after).toEqual({ ...payment, checkFailures: 0, nextCheckAt: null });
      expect((await alertRow(alertId)).resolvedAt).toBeNull();
      const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
      expect(order.status).toBe('PENDING_PAYMENT');

      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
      expect(mp.getSpy).toHaveBeenCalledWith(payment.providerPaymentId);
    });

    it('409 para outro tipo, para pagamento fora do teto e na segunda vez', async () => {
      const { alertId, payment } = await stoppedPayment();
      const other = await insertAlert(payment.id, 'PAID_AFTER_EXPIRY');
      const wrongType = await post(other, 'resume-reconciliation').expect(409);
      expect(wrongType.body).toMatchObject({ code: 'ALERT_NOT_RESUMABLE' });

      await ctx.db
        .update(payments)
        .set({ checkFailures: RECONCILIATION_MAX_FAILURES - 1 })
        .where(eq(payments.id, payment.id));
      const below = await post(alertId, 'resume-reconciliation').expect(409);
      expect(below.body).toMatchObject({ code: 'RECONCILIATION_NOT_STOPPED' });
      expect((await paymentOf(payment.orderId)).checkFailures).toBe(
        RECONCILIATION_MAX_FAILURES - 1,
      );

      await ctx.db
        .update(payments)
        .set({ checkFailures: RECONCILIATION_MAX_FAILURES })
        .where(eq(payments.id, payment.id));
      await post(alertId, 'resume-reconciliation').expect(200);
      const twice = await post(alertId, 'resume-reconciliation').expect(409);
      expect(twice.body).toMatchObject({ code: 'RECONCILIATION_NOT_STOPPED' });
    });
  });

  describe('alerta que se repete (recordAlert)', () => {
    it('RECONCILIATION_STOPPED resolvido e retomado que para de novo é reaberto, com created_at novo', async () => {
      const v = await variantWithStock(2);
      const { payment, providerPaymentId } = await orderWithPix(v.id);
      mp.remote.delete(providerPaymentId);
      await failUntilStopped(payment.id);
      const [first] = await alertsOfPayment(payment.id);
      expect(first).toMatchObject({ alert: 'RECONCILIATION_STOPPED', resolvedAt: null });
      expect(alertWarnings(providerPaymentId, 'RECONCILIATION_STOPPED')).toHaveLength(1);

      await post(first.id, 'resolve').expect(200);
      await post(first.id, 'resume-reconciliation').expect(200);
      await failUntilStopped(payment.id);

      const rows = await alertsOfPayment(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.id, resolvedAt: null, resolvedBy: null });
      expect(rows[0].createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
      expect(alertWarnings(providerPaymentId, 'RECONCILIATION_STOPPED')).toHaveLength(2);
      expect((await paymentOf(payment.orderId)).alert).toBe('RECONCILIATION_STOPPED');
      expect((await list().expect(200)).body.items).toEqual([
        expect.objectContaining({ id: first.id, type: 'RECONCILIATION_STOPPED' }),
      ]);
    });

    it('aberto que se repete não muda (nem created_at, nem log), com ou sem reopen', async () => {
      const { alertId, payment, orderId, providerPaymentId } = await stoppedPayment();
      const before = await alertRow(alertId);
      const transition = ctx.app.get(PaymentTransitionService);
      for (const reopen of [true, false]) {
        await transition.recordAlert(
          ctx.db,
          { paymentId: payment.id, providerPaymentId, orderId, alert: 'RECONCILIATION_STOPPED' },
          { reopen },
        );
      }
      expect(await alertsOfPayment(payment.id)).toEqual([before]);
      expect(alertWarnings(providerPaymentId, 'RECONCILIATION_STOPPED')).toEqual([]);
    });

    it('PAYMENT_REVERSED resolvido não reabre com consultas repetidas (charged_back segue APPROVED)', async () => {
      const v = await variantWithStock(2);
      const { payment, providerPaymentId, orderId } = await orderWithPix(v.id);
      mp.remote.set(providerPaymentId, {
        ...mp.remote.get(providerPaymentId)!,
        ...mpStatus.approved,
        dateLastUpdated: new Date(),
      });
      await reconciliation.reconcile();
      mp.remote.set(providerPaymentId, {
        ...mp.remote.get(providerPaymentId)!,
        ...mpStatus.chargedBack,
      });
      await webhook(providerPaymentId).expect(200);
      const [alert] = await alertsOfPayment(payment.id);
      expect(alert.alert).toBe('PAYMENT_REVERSED');
      await post(alert.id, 'resolve').expect(200);
      const resolved = await alertRow(alert.id);

      await webhook(providerPaymentId).expect(200);
      await ctx.db
        .update(payments)
        .set({ lastCheckedAt: new Date(Date.now() - 7 * 3600_000) })
        .where(eq(payments.id, payment.id));
      expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });

      expect(await alertsOfPayment(payment.id)).toEqual([resolved]);
      expect(alertWarnings(providerPaymentId, 'PAYMENT_REVERSED')).toHaveLength(1);
      expect((await paymentOf(orderId)).status).toBe('APPROVED');
    });
  });
});
