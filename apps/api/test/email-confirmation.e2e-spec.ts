import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { OrderStatus } from '@otilc/shared';
import { AdminAuthService } from '../src/admin-auth/admin-auth.service';
import { createAdminUser } from '../src/admin-auth/new-admin';
import { SESSION_COOKIE } from '../src/admin-auth/session-token';
import { emailOutbox, orders, payments, products, variants } from '../src/db/schema';
import { EMAIL_MAX_ATTEMPTS, EmailOutboxService } from '../src/email/email-outbox.service';
import { PIX_PROVIDER, type MercadoPagoClient } from '../src/payments/mercadopago.client';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service';
import {
  mockMercadoPago,
  mpStatus,
  setupPixTestApp,
  signature,
  type MercadoPagoMock,
} from './pix-setup';
import { resetData, teardownTestApp, type TestContext } from './setup';

const RESEND_URL = 'https://api.resend.com/emails';
const WEB_ORIGIN = 'http://localhost:3000';
const REPLY_TO = 'atendimento@example.com';
const PASSWORD = randomBytes(24).toString('base64url');
const customer = { name: 'Caio Reis', email: 'caio@example.com', phone: '+5585999990002' };

interface ResendCall {
  headers: Record<string, string>;
  body: {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text: string;
    reply_to?: string;
  };
}

describe('E-mail de confirmação do pedido pago (integração, provedores simulados)', () => {
  let ctx: TestContext;
  let client: MercadoPagoClient;
  let mp: MercadoPagoMock;
  let outbox: EmailOutboxService;
  let reconciliation: PaymentReconciliationService;
  /** Chamadas que chegaram ao Resend simulado. */
  let resendCalls: ResendCall[];
  /** Resposta do Resend simulado à próxima chamada. */
  let resendReply: () => Response;
  let logSpies: jest.SpyInstance[];
  let ipCounter = 0;
  const nextIp = () => `10.80.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await setupPixTestApp({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: `re_teste_${randomBytes(16).toString('hex')}`,
      EMAIL_FROM: 'OTILC <pedidos@example.com>',
      EMAIL_REPLY_TO: REPLY_TO,
    });
    client = ctx.app.get<MercadoPagoClient>(PIX_PROVIDER);
    outbox = ctx.app.get(EmailOutboxService);
    reconciliation = ctx.app.get(PaymentReconciliationService);
  });
  beforeEach(async () => {
    await resetData(ctx.db);
    await ctx.db.execute(sql`TRUNCATE payment_notifications`);
    mp = mockMercadoPago(client);
    resendCalls = [];
    resendReply = () => json({ id: `msg-${resendCalls.length}` });
    // Nada sai para a rede: o cliente do Resend lê o `fetch` global a cada envio.
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) !== RESEND_URL)
        throw new Error(`rede bloqueada no teste: ${String(input)}`);
      resendCalls.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as ResendCall['body'],
      });
      await sleep(30);
      return resendReply();
    });
    logSpies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level),
    );
  });
  afterEach(() => {
    // Nenhum log, em nenhum teste, traz dados do cliente (spec-036).
    const logged = logSpies
      .flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' ')))
      .join('\n');
    for (const pii of [customer.email, customer.name, customer.phone]) {
      expect(logged).not.toContain(pii);
    }
    jest.restoreAllMocks();
  });
  afterAll(() => teardownTestApp(ctx));

  const http = () => request(ctx.app.getHttpServer());
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function variantWithStock(slug: string, stock: number) {
    const product = await ctx.db.query.products.findFirst({
      where: eq(products.slug, slug),
      with: { variants: true },
    });
    if (!product) throw new Error(`produto ${slug} ausente na seed`);
    const [v] = product.variants;
    await ctx.db.update(variants).set({ stock }).where(eq(variants.id, v.id));
    return { ...v, name: product.name, price: product.priceCents };
  }

  async function placeOrder(variantId: string, quantity = 1) {
    const res = await http()
      .post('/api/orders')
      .set('X-Forwarded-For', nextIp())
      .send({ items: [{ variantId, quantity }], customer })
      .expect(201);
    return res.body as { id: string; number: number; totalCents: number };
  }

  /** Pedido com Pix pendente criado há 5 min (a conciliação ignora os de menos de 2 min). */
  async function orderWithPix(variantId: string, quantity = 1) {
    const order = await placeOrder(variantId, quantity);
    await http().post(`/api/orders/${order.id}/pix`).set('X-Forwarded-For', nextIp()).expect(201);
    await ctx.db
      .update(payments)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(payments.orderId, order.id));
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, order.id));
    return { order, paymentId: row.providerPaymentId };
  }

  function approve(id: string) {
    mp.remote.set(id, { ...mp.remote.get(id)!, ...mpStatus.approved, dateLastUpdated: new Date() });
  }

  function webhook(dataId: string, requestId = randomUUID()) {
    return http()
      .post(`/api/webhooks/mercadopago?data.id=${dataId}&type=order`)
      .set('X-Forwarded-For', nextIp())
      .set('x-request-id', requestId)
      .set('x-signature', signature(dataId, requestId))
      .send({ type: 'order', action: 'order.processed', data: { id: dataId } });
  }

  function markPaid(orderId: string, cookie: string) {
    return http()
      .patch(`/api/admin/orders/${orderId}/status`)
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send({ status: 'PAID' });
  }

  async function staffCookie(): Promise<string> {
    const email = 'staff@example.test';
    await createAdminUser(ctx.db, { email, name: 'STAFF', role: 'STAFF', password: PASSWORD });
    const { token } = await ctx.app.get(AdminAuthService).login({ email, password: PASSWORD });
    return `${SESSION_COOKIE}=${token}`;
  }

  async function orderStatus(id: string): Promise<OrderStatus> {
    const [row] = await ctx.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, id));
    return row.status;
  }

  const outboxRows = () => ctx.db.select().from(emailOutbox);

  /** Deixa a próxima tentativa vencida, como se o backoff tivesse passado. */
  async function backoffElapsed() {
    await ctx.db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
  }

  it('webhook aprovado: pedido PAID, 1 linha na outbox e 1 envio com destinatário, assunto e idempotência certos', async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const { order, paymentId } = await orderWithPix(v.id, 2);
    approve(paymentId);

    await webhook(paymentId).expect(200);

    expect(await orderStatus(order.id)).toBe('PAID');
    const [pending] = await outboxRows();
    expect(pending).toMatchObject({
      orderId: order.id,
      kind: 'order_confirmation',
      status: 'pending',
      attempts: 0,
    });
    // O webhook não espera o provedor: em teste, só a rodada chamada aqui envia.
    expect(resendCalls).toEqual([]);

    expect(await outbox.run()).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(resendCalls).toHaveLength(1);
    const [call] = resendCalls;
    expect(call.headers['Idempotency-Key']).toBe(`order-confirmation/${order.id}`);
    expect(call.body).toMatchObject({
      from: 'OTILC <pedidos@example.com>',
      to: [customer.email],
      subject: `Pedido nº ${order.number} confirmado`,
      reply_to: REPLY_TO,
    });
    expect(call.body.text).toContain(v.name);
    expect(call.body.text).toContain('· 2 ×');
    expect(call.body.html).toContain(customer.name);
    const rows = await outboxRows();
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'sent',
        attempts: 1,
        providerMessageId: 'msg-1',
        lastError: null,
        sentAt: expect.any(Date),
      }),
    ]);
  });

  it('webhook repetido, notificação nova e conciliação depois não criam linha nem reenviam', async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const { order, paymentId } = await orderWithPix(v.id);
    approve(paymentId);
    const requestId = randomUUID();
    await webhook(paymentId, requestId).expect(200);
    await outbox.run();

    await webhook(paymentId, requestId).expect(200);
    await webhook(paymentId).expect(200);
    expect(await reconciliation.reconcile()).toEqual({ checked: 1, failed: 0 });
    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 0 });

    expect(await orderStatus(order.id)).toBe('PAID');
    expect(await outboxRows()).toHaveLength(1);
    expect(resendCalls).toHaveLength(1);
  });

  it('"marcar pago" no painel: 1 linha e 1 envio; a segunda tentativa não muda nada', async () => {
    const cookie = await staffCookie();
    const v = await variantWithStock('05-camiseta-preta', 3);
    const order = await placeOrder(v.id);

    await markPaid(order.id, cookie).expect(200);
    expect(await orderStatus(order.id)).toBe('PAID');
    expect(await outboxRows()).toEqual([
      expect.objectContaining({ orderId: order.id, status: 'pending' }),
    ]);
    expect(await outbox.run()).toEqual({ sent: 1, retried: 0, failed: 0 });

    const again = await markPaid(order.id, cookie);
    expect(again.status).toBe(409);
    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 0 });

    expect(await outboxRows()).toEqual([expect.objectContaining({ status: 'sent' })]);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0].body.to).toEqual([customer.email]);
  });

  it('webhook e conciliação simultâneos do mesmo pagamento: 1 linha e 1 envio', async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const { order, paymentId } = await orderWithPix(v.id);
    approve(paymentId);

    const [res] = await Promise.all([webhook(paymentId), reconciliation.reconcile()]);
    expect(res.status).toBe(200);

    expect(await orderStatus(order.id)).toBe('PAID');
    expect(await outboxRows()).toHaveLength(1);
    await outbox.run();
    expect(resendCalls).toHaveLength(1);
  });

  it('duas rodadas do worker em paralelo sobre a mesma linha chamam o provedor 1 vez', async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const { paymentId } = await orderWithPix(v.id);
    approve(paymentId);
    await webhook(paymentId).expect(200);

    const results = await Promise.all([outbox.run(), outbox.run(), outbox.run()]);

    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(resendCalls).toHaveLength(1);
    expect(await outboxRows()).toEqual([expect.objectContaining({ status: 'sent', attempts: 1 })]);
  });

  it('provedor com 500: webhook responde 200, pedido segue PAID, a linha volta com backoff e sai depois', async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const { order, paymentId } = await orderWithPix(v.id);
    approve(paymentId);
    resendReply = () => json({ name: 'internal_server_error', message: customer.email }, 500);

    await webhook(paymentId).expect(200);
    const before = Date.now();
    expect(await outbox.run()).toEqual({ sent: 0, retried: 1, failed: 0 });

    expect(await orderStatus(order.id)).toBe('PAID');
    const [row] = await outboxRows();
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Resend respondeu 500 (internal_server_error).',
    });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before);

    // Antes do backoff, nada é reenviado.
    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(resendCalls).toHaveLength(1);

    resendReply = () => json({ id: 'msg-depois-do-500' });
    await backoffElapsed();
    expect(await outbox.run()).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(await outboxRows()).toEqual([
      expect.objectContaining({
        status: 'sent',
        attempts: 2,
        providerMessageId: 'msg-depois-do-500',
        lastError: null,
      }),
    ]);
    expect(resendCalls).toHaveLength(2);
    // As duas tentativas usam a mesma chave: o Resend não manda duas vezes.
    expect(new Set(resendCalls.map((c) => c.headers['Idempotency-Key']))).toEqual(
      new Set([`order-confirmation/${order.id}`]),
    );
  });

  it(`na ${EMAIL_MAX_ATTEMPTS}ª falha temporária a linha vira failed; o pedido segue PAID`, async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const { order, paymentId } = await orderWithPix(v.id);
    approve(paymentId);
    await webhook(paymentId).expect(200);
    resendReply = () => json({ name: 'rate_limit_exceeded' }, 429);

    for (let attempt = 1; attempt < EMAIL_MAX_ATTEMPTS; attempt++) {
      expect(await outbox.run()).toEqual({ sent: 0, retried: 1, failed: 0 });
      await backoffElapsed();
    }
    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 1 });

    expect(await outboxRows()).toEqual([
      expect.objectContaining({
        status: 'failed',
        attempts: EMAIL_MAX_ATTEMPTS,
        lastError: 'Resend respondeu 429 (rate_limit_exceeded).',
        sentAt: null,
      }),
    ]);
    await backoffElapsed();
    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(resendCalls).toHaveLength(EMAIL_MAX_ATTEMPTS);
    expect(await orderStatus(order.id)).toBe('PAID');
  });

  it('provedor com 422: a linha vira failed sem nova tentativa; o pedido segue PAID', async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const { order, paymentId } = await orderWithPix(v.id);
    approve(paymentId);
    await webhook(paymentId).expect(200);
    resendReply = () => json({ name: 'validation_error', message: customer.email }, 422);

    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 1 });
    await backoffElapsed();
    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 0 });

    expect(await outboxRows()).toEqual([
      expect.objectContaining({
        status: 'failed',
        attempts: 1,
        lastError: 'Resend respondeu 422 (validation_error).',
      }),
    ]);
    expect(resendCalls).toHaveLength(1);
    expect(await orderStatus(order.id)).toBe('PAID');
  });

  it('transição que não chega a PAID não cria linha: rejeitado, valor divergente, pago depois do prazo, expirado', async () => {
    const v = await variantWithStock('05-camiseta-preta', 6);

    const rejected = await orderWithPix(v.id);
    mp.remote.set(rejected.paymentId, {
      ...mp.remote.get(rejected.paymentId)!,
      ...mpStatus.rejected,
    });
    await webhook(rejected.paymentId).expect(200);

    const mismatch = await orderWithPix(v.id);
    approve(mismatch.paymentId);
    mp.remote.set(mismatch.paymentId, { ...mp.remote.get(mismatch.paymentId)!, amountCents: 1 });
    await webhook(mismatch.paymentId).expect(200);

    const late = await orderWithPix(v.id);
    await ctx.db
      .update(orders)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(orders.id, late.order.id));
    approve(late.paymentId);
    await webhook(late.paymentId).expect(200);

    const expired = await orderWithPix(v.id);
    mp.remote.set(expired.paymentId, {
      ...mp.remote.get(expired.paymentId)!,
      ...mpStatus.expired,
    });
    await webhook(expired.paymentId).expect(200);

    expect(await orderStatus(rejected.order.id)).toBe('PENDING_PAYMENT');
    expect(await orderStatus(mismatch.order.id)).toBe('PENDING_PAYMENT');
    expect(await orderStatus(late.order.id)).toBe('PENDING_PAYMENT');
    expect(await orderStatus(expired.order.id)).toBe('PENDING_PAYMENT');
    expect(await outboxRows()).toEqual([]);
    expect(await outbox.run()).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(resendCalls).toEqual([]);
  });

  it('a tabela recusa tipo e status desconhecidos e dois e-mails do mesmo tipo por pedido', async () => {
    const v = await variantWithStock('05-camiseta-preta', 3);
    const order = await placeOrder(v.id);
    await ctx.db.insert(emailOutbox).values({ orderId: order.id, kind: 'order_confirmation' });

    await expect(
      ctx.db.insert(emailOutbox).values({ orderId: order.id, kind: 'order_confirmation' }),
    ).rejects.toThrow();
    await expect(
      ctx.db.insert(emailOutbox).values({ orderId: order.id, kind: 'shipped' }),
    ).rejects.toThrow();
    await expect(
      ctx.db
        .update(emailOutbox)
        .set({ status: 'bounced' })
        .where(eq(emailOutbox.orderId, order.id)),
    ).rejects.toThrow();
    await expect(
      ctx.db.update(emailOutbox).set({ status: 'sent' }).where(eq(emailOutbox.orderId, order.id)),
    ).rejects.toThrow();
  });
});
