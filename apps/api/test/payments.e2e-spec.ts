import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import type { OrderStatus } from '@otilc/shared';
import { orders, paymentNotifications, payments, products, variants } from '../src/db/schema';
import { AdminOrdersService } from '../src/admin-orders/admin-orders.service';
import { OrdersService } from '../src/orders/orders.service';
import {
  PIX_PROVIDER,
  PixProviderError,
  type CreatePixInput,
  type MercadoPagoClient,
  type ProviderPayment,
} from '../src/payments/mercadopago.client';
import { fakeOrderId, mpStatus, notCancellable, setupPixTestApp, signature } from './pix-setup';
import { resetData, setupTestApp, teardownTestApp, type TestContext } from './setup';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };
const QR_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('Pix com Mercado Pago (integração com Postgres, provedor simulado)', () => {
  let ctx: TestContext;
  let client: MercadoPagoClient;
  let createSpy: jest.SpyInstance<
    Promise<ProviderPayment & { qrCode: string; qrCodeBase64: string }>,
    [CreatePixInput]
  >;
  let getSpy: jest.SpyInstance<Promise<ProviderPayment>, [string]>;
  /** Estado dos pagamentos "no Mercado Pago", por id. */
  let remote: Map<string, ProviderPayment>;
  // O limite geral é por IP e vive enquanto o app vive: cada requisição usa um IP próprio.
  let ipCounter = 0;
  const nextIp = () => `10.60.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await setupPixTestApp();
    client = ctx.app.get<MercadoPagoClient>(PIX_PROVIDER);
  });
  beforeEach(async () => {
    await resetData(ctx.db);
    await ctx.db.execute(sql`TRUNCATE payment_notifications`);
    remote = new Map();
    const byKey = new Map<string, string>();
    let next = 1_000_000;
    createSpy = jest.spyOn(client, 'createPixPayment').mockImplementation(async (input) => {
      // Como o Mercado Pago: a mesma chave de idempotência devolve a mesma order.
      await sleep(30);
      let id = byKey.get(input.idempotencyKey);
      if (!id) {
        id = fakeOrderId(next++);
        byKey.set(input.idempotencyKey, id);
        remote.set(id, {
          id,
          ...mpStatus.pending,
          externalReference: input.orderId,
          amountCents: input.amountCents,
          paidAmountCents: null,
          currency: 'BRL',
          dateLastUpdated: new Date(),
        });
      }
      return { ...remote.get(id)!, qrCode: `00020126-pix-ficticio-${id}`, qrCodeBase64: QR_BASE64 };
    });
    getSpy = jest.spyOn(client, 'getPayment').mockImplementation(async (id) => {
      await sleep(10);
      const payment = remote.get(id);
      if (!payment) throw new PixProviderError('Mercado Pago respondeu 404.');
      return { ...payment };
    });
    // O painel cancela o Pix pendente antes de marcar pago (spec-019); order já paga não é
    // cancelável, e o estado real vem do GET.
    jest.spyOn(client, 'cancelPayment').mockImplementation(async (id) => {
      await sleep(10);
      const payment = remote.get(id);
      if (!payment) throw new PixProviderError('Mercado Pago respondeu 404.');
      if (payment.status !== 'action_required') throw notCancellable('invalid_order_status');
      remote.set(id, { ...payment, ...mpStatus.canceled });
      return { ...remote.get(id)! };
    });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => teardownTestApp(ctx));

  const http = () => request(ctx.app.getHttpServer());
  const createPix = (orderId: string) =>
    http().post(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp());
  const getPix = (orderId: string) =>
    http().get(`/api/orders/${orderId}/pix`).set('X-Forwarded-For', nextIp());

  function webhook(
    dataId: string,
    opts: {
      requestId?: string;
      ts?: number;
      sig?: string | null;
      body?: unknown;
      query?: string;
    } = {},
  ) {
    const requestId = opts.requestId ?? randomUUID();
    const req = http()
      .post(`/api/webhooks/mercadopago?${opts.query ?? `data.id=${dataId}&type=order`}`)
      .set('X-Forwarded-For', nextIp())
      .set('x-request-id', requestId);
    const sig = opts.sig === undefined ? signature(dataId, requestId, opts.ts) : opts.sig;
    if (sig !== null) req.set('x-signature', sig);
    return req.send(
      opts.body ?? { type: 'order', action: 'order.processed', data: { id: dataId } },
    );
  }

  /** Variação da seed com o estoque pedido. */
  async function variantWithStock(slug: string, stock: number) {
    const product = await ctx.db.query.products.findFirst({
      where: eq(products.slug, slug),
      with: { variants: true },
    });
    if (!product) throw new Error(`produto ${slug} ausente na seed`);
    const [v] = product.variants;
    await ctx.db.update(variants).set({ stock }).where(eq(variants.id, v.id));
    return { ...v, stock, price: product.priceCents };
  }

  async function placeOrder(items: { variantId: string; quantity: number }[]) {
    const res = await http()
      .post('/api/orders')
      .set('X-Forwarded-For', nextIp())
      .send({ items, customer })
      .expect(201);
    return res.body as { id: string; totalCents: number; expiresAt: string };
  }

  /** Pedido com cobrança Pix pendente; devolve o id da order no provedor. */
  async function orderWithPix(variantId: string, quantity = 1) {
    const order = await placeOrder([{ variantId, quantity }]);
    await createPix(order.id).expect(201);
    const [row] = await ctx.db.select().from(payments).where(eq(payments.orderId, order.id));
    return { order, paymentId: row.providerPaymentId };
  }

  function approve(id: string, over: Partial<ProviderPayment> = {}) {
    remote.set(id, {
      ...remote.get(id)!,
      ...mpStatus.approved,
      dateLastUpdated: new Date(),
      ...over,
    });
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
  async function notificationCount() {
    const rows = await ctx.db.select().from(paymentNotifications);
    return rows.length;
  }

  describe('POST /api/orders/:id/pix', () => {
    it('cria a cobrança com o valor do banco; a segunda chamada devolve a mesma sem chamar o provedor', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const order = await placeOrder([{ variantId: v.id, quantity: 2 }]);
      const before = Date.now();

      const res = await createPix(order.id).expect(201);

      expect(res.body).toEqual({
        orderId: order.id,
        orderStatus: 'PENDING_PAYMENT',
        status: 'PENDING',
        amountCents: v.price * 2,
        qrCode: expect.stringMatching(/^00020126/),
        qrCodeBase64: QR_BASE64,
        expiresAt: order.expiresAt,
      });
      expect(createSpy).toHaveBeenCalledTimes(1);
      const input = createSpy.mock.calls[0][0];
      expect(input).toEqual({
        orderId: order.id,
        orderNumber: expect.any(Number),
        amountCents: v.price * 2,
        payerEmail: customer.email,
        // Primeiro nome do cliente (no sandbox, "APRO" aprova o Pix sozinho).
        payerFirstName: 'Ana',
        expirationTime: 'PT31M',
        idempotencyKey: `otilc-pix-${order.id}-1`,
      });
      // Validade do Pix (pix-expiration.ts, Q13): 30 min + 1 de folga a partir da criação, porque o
      // Mercado Pago exige no mínimo 30 min. O prazo do pedido continua sendo o expiresAt dele.
      const row = await paymentOf(order.id);
      const validity = row.expiresAt.getTime() - before;
      expect(validity).toBeGreaterThanOrEqual(31 * 60_000 - 1000);
      expect(validity).toBeLessThanOrEqual(31 * 60_000 + 5000);
      expect(row.providerPaymentId).toMatch(/^ORD[0-9A-Z]{26}$/);
      expect(row.amountCents).toBe(order.totalCents);

      const again = await createPix(order.id).expect(200);
      expect(again.body).toEqual(res.body);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('duas (ou mais) chamadas simultâneas geram uma cobrança só, e todas devolvem a mesma', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const order = await placeOrder([{ variantId: v.id, quantity: 1 }]);

      const results = await Promise.all(Array.from({ length: 5 }, () => createPix(order.id)));

      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(new Set(results.map((r) => r.body.qrCode)).size).toBe(1);
      await paymentOf(order.id);
    });

    it('cobrança rejeitada permite uma nova tentativa, com outra chave de idempotência', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const { order, paymentId } = await orderWithPix(v.id);
      remote.set(paymentId, { ...remote.get(paymentId)!, ...mpStatus.rejected });
      await webhook(paymentId).expect(200);

      await createPix(order.id).expect(201);

      expect(createSpy.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([
        `otilc-pix-${order.id}-1`,
        `otilc-pix-${order.id}-2`,
      ]);
      const rows = await ctx.db.select().from(payments).where(eq(payments.orderId, order.id));
      expect(rows.map((r) => r.status).sort()).toEqual(['PENDING', 'REJECTED']);
    });

    it('409 ORDER_NOT_PAYABLE para pedido PAID, EXPIRED ou com prazo vencido', async () => {
      const v = await variantWithStock('05-camiseta-preta', 5);
      const paid = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      const expired = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      const late = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      await ctx.db.update(orders).set({ status: 'PAID' }).where(eq(orders.id, paid.id));
      await ctx.db.update(orders).set({ status: 'EXPIRED' }).where(eq(orders.id, expired.id));
      await ctx.db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(orders.id, late.id));

      for (const id of [paid.id, expired.id, late.id]) {
        const res = await createPix(id).expect(409);
        expect(res.body).toMatchObject({ statusCode: 409, code: 'ORDER_NOT_PAYABLE' });
        expect(res.body.message).toMatch(/não pode mais ser pago/);
      }
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('400 id inválido, 404 pedido inexistente', async () => {
      await createPix('nao-e-uuid').expect(400);
      await createPix(MISSING_ID).expect(404);
    });

    it('503 PIX_UNAVAILABLE quando o Mercado Pago falha; pedido e reserva não mudam', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const order = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      createSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago respondeu 500.'));

      const res = await createPix(order.id).expect(503);

      expect(res.body).toMatchObject({ statusCode: 503, code: 'PIX_UNAVAILABLE' });
      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
      expect(await ctx.db.select().from(payments)).toEqual([]);
    });
  });

  describe('webhook', () => {
    it('assinatura inválida, ausente, de outro segredo ou fora da janela → 401 e nada gravado', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      approve(paymentId);
      const old = Math.floor(Date.now() / 1000) - 6 * 60;
      const requestId = randomUUID();

      await webhook(paymentId, { sig: null }).expect(401);
      await webhook(paymentId, { sig: 'ts=1,v1=abc' }).expect(401);
      await webhook(paymentId, {
        sig: signature(paymentId, requestId, undefined, 'outro-segredo'),
      }).expect(401);
      await webhook(paymentId, { ts: old }).expect(401);
      // Assinatura válida para outro pagamento não serve para este.
      await webhook(paymentId, { requestId, sig: signature('999', requestId) }).expect(401);
      // Mesmo com corpo inválido, a assinatura é conferida antes.
      await webhook(paymentId, { sig: null, body: { nada: true } }).expect(401);

      expect(getSpy).not.toHaveBeenCalled();
      expect(await notificationCount()).toBe(0);
      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
    });

    it('400 para query ou corpo inválidos, ou id do corpo diferente do assinado', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { paymentId } = await orderWithPix(v.id);

      await webhook(paymentId, { query: 'type=order' }).expect(400);
      await webhook(paymentId, { body: { type: 'order' } }).expect(400);
      await webhook(paymentId, { body: { type: 'order', data: { id: fakeOrderId(1) } } }).expect(
        400,
      );
      expect(await notificationCount()).toBe(0);
    });

    it('notificação type=payment (API de Pagamentos) → 200 ignorada, sem consultar nem registrar', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      approve(paymentId);
      const legacyId = '5466310457';

      // Como o Mercado Pago manda enquanto o evento de Pagamentos ainda está ligado no painel.
      await webhook(legacyId, {
        query: `data.id=${legacyId}&type=payment`,
        body: { type: 'payment', action: 'payment.updated', data: { id: Number(legacyId) } },
      }).expect(200);
      // Mesmo com o id de uma order nossa, type=payment não é processado.
      await webhook(paymentId, {
        query: `data.id=${paymentId}&type=payment`,
        body: { type: 'payment', action: 'payment.updated', data: { id: paymentId } },
      }).expect(200);

      expect(getSpy).not.toHaveBeenCalled();
      expect(await notificationCount()).toBe(0);
      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
    });

    it('type=order com data.id fora do formato de order (ex.: numérico) → 400, nada registrado', async () => {
      for (const id of [
        '5466310457',
        'PAY01JP84C939T20S0P1DN382FQ6K',
        'ord01jp84c939t20s0p1dn382fq6k',
      ]) {
        await webhook(id).expect(400);
      }
      expect(getSpy).not.toHaveBeenCalled();
      expect(await notificationCount()).toBe(0);
    });

    it('pagamento aprovado → pedido PAID, reserved e stock baixam uma vez', async () => {
      const a = await variantWithStock('05-camiseta-preta', 4);
      const b = await variantWithStock('07-camiseta-branca', 4);
      const order = await placeOrder([
        { variantId: a.id, quantity: 2 },
        { variantId: b.id, quantity: 1 },
      ]);
      await createPix(order.id).expect(201);
      const { providerPaymentId } = await paymentOf(order.id);
      approve(providerPaymentId);

      await webhook(providerPaymentId).expect(200);

      expect(await orderStatus(order.id)).toBe('PAID');
      expect(await stockOf(a.id)).toEqual({ stock: 2, reserved: 0 });
      expect(await stockOf(b.id)).toEqual({ stock: 3, reserved: 0 });
      expect(await paymentOf(order.id)).toMatchObject({
        status: 'APPROVED',
        alert: null,
        approvedAt: expect.any(Date),
      });
      expect(await notificationCount()).toBe(1);
    });

    it('mesma notificação repetida e notificações diferentes, simultâneas → PAID e baixa uma vez só', async () => {
      const v = await variantWithStock('05-camiseta-preta', 5);
      const { order, paymentId } = await orderWithPix(v.id, 2);
      approve(paymentId);
      const repeated = randomUUID();

      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => webhook(paymentId, { requestId: repeated })),
        ...Array.from({ length: 4 }, () => webhook(paymentId)),
      ]);

      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await orderStatus(order.id)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 3, reserved: 0 });
      expect(await notificationCount()).toBe(5);

      // Reprocessar depois também não muda nada.
      await webhook(paymentId).expect(200);
      expect(await stockOf(v.id)).toEqual({ stock: 3, reserved: 0 });
    });

    it('o status do corpo é ignorado: corpo diz approved, provedor diz pending', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);

      await webhook(paymentId, {
        body: { type: 'order', status: 'processed', data: { id: paymentId, status: 'processed' } },
      }).expect(200);

      expect(getSpy).toHaveBeenCalledWith(paymentId);
      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
      expect((await paymentOf(order.id)).status).toBe('PENDING');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
    });

    it('falha do provedor → 500, nada registrado, e o reenvio processa normalmente', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      approve(paymentId);
      const requestId = randomUUID();
      getSpy.mockRejectedValueOnce(new PixProviderError('Mercado Pago indisponível (rede).'));

      await webhook(paymentId, { requestId }).expect(500);
      expect(await notificationCount()).toBe(0);
      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');

      await webhook(paymentId, { requestId }).expect(200);
      expect(await orderStatus(order.id)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
    });

    it('tipo diferente de order e order desconhecida → 200 sem mudar nada', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      approve(paymentId);

      await webhook(paymentId, {
        query: `data.id=${paymentId}&type=merchant_order`,
        body: { type: 'merchant_order', data: { id: paymentId } },
      }).expect(200);
      await webhook(fakeOrderId(424242)).expect(200);

      expect(getSpy).not.toHaveBeenCalled();
      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
      expect(await notificationCount()).toBe(0);
    });

    it('notificação de pagamento desconhecido não é registrada; a mesma, depois da cobrança gravada, é processada', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const order = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      // O provedor simulado numera as orders a partir de 1000000 em cada teste.
      const early = fakeOrderId(1_000_000);
      const requestId = randomUUID();

      await webhook(early, { requestId }).expect(200);
      expect(await notificationCount()).toBe(0);

      await createPix(order.id).expect(201);
      expect((await paymentOf(order.id)).providerPaymentId).toBe(early);
      approve(early);
      await webhook(early, { requestId }).expect(200);

      expect(await orderStatus(order.id)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
      expect(await notificationCount()).toBe(1);
    });

    it('aprovado para pedido já EXPIRED → continua EXPIRED, estoque intacto, alerta PAID_AFTER_EXPIRY', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      await ctx.app.get(OrdersService).releaseExpired(new Date(Date.now() + 31 * 60_000));
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
      approve(paymentId);

      await webhook(paymentId).expect(200);

      expect(await orderStatus(order.id)).toBe('EXPIRED');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
      expect(await paymentOf(order.id)).toMatchObject({
        status: 'APPROVED',
        alert: 'PAID_AFTER_EXPIRY',
      });
    });

    it('pedido ainda PENDING_PAYMENT com prazo vencido e aprovado antes do prazo → PAID', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      const expiresAt = new Date(Date.now() - 60_000);
      await ctx.db.update(orders).set({ expiresAt }).where(eq(orders.id, order.id));
      approve(paymentId, { dateLastUpdated: new Date(expiresAt.getTime() - 1000) });

      await webhook(paymentId).expect(200);

      expect(await orderStatus(order.id)).toBe('PAID');
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
    });

    it('pedido ainda PENDING_PAYMENT, aprovado depois do prazo → não paga, alerta PAID_AFTER_EXPIRY', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      const expiresAt = new Date(Date.now() - 60_000);
      await ctx.db.update(orders).set({ expiresAt }).where(eq(orders.id, order.id));
      approve(paymentId, { dateLastUpdated: new Date() });

      await webhook(paymentId).expect(200);

      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
      expect((await paymentOf(order.id)).alert).toBe('PAID_AFTER_EXPIRY');
    });

    it.each([
      ['valor', { amountCents: 1 }],
      ['valor pago', { paidAmountCents: 1 }],
      ['moeda', { currency: 'USD' }],
      ['referência', { externalReference: MISSING_ID }],
    ])('%s divergente → pedido não muda, alerta AMOUNT_MISMATCH', async (_label, over) => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);
      approve(paymentId, over);

      await webhook(paymentId).expect(200);

      expect(await orderStatus(order.id)).toBe('PENDING_PAYMENT');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
      expect(await paymentOf(order.id)).toMatchObject({
        status: 'APPROVED',
        alert: 'AMOUNT_MISMATCH',
      });
    });

    it.each<[OrderStatus[]]>([[['PAID']], [['PAID', 'SHIPPED']]])(
      'aprovado para pedido já pago pelo painel (%j) → alerta DUPLICATE_PAYMENT, pedido e estoque intactos',
      async (steps) => {
        const v = await variantWithStock('05-camiseta-preta', 2);
        const { order, paymentId } = await orderWithPix(v.id);
        const admin = ctx.app.get(AdminOrdersService);
        for (const to of steps) await admin.updateStatus(order.id, to);
        const final = steps[steps.length - 1];
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
        approve(paymentId);

        await webhook(paymentId).expect(200);

        expect(await orderStatus(order.id)).toBe(final);
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
        expect(await paymentOf(order.id)).toMatchObject({
          status: 'APPROVED',
          alert: 'DUPLICATE_PAYMENT',
        });

        // Reprocessar não muda nada.
        await webhook(paymentId).expect(200);
        expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
      },
    );

    it('estresse: webhook aprovado e job de expiração ao mesmo tempo, PAID ou EXPIRED, nunca os dois', async () => {
      const ROUNDS = 6;
      const ORDERS_PER_ROUND = 4;
      const initialStock = ROUNDS * ORDERS_PER_ROUND;
      const a = await variantWithStock('05-camiseta-preta', initialStock);
      const b = await variantWithStock('07-camiseta-branca', initialStock);
      const service = ctx.app.get(OrdersService);
      const ids: string[] = [];

      for (let round = 0; round < ROUNDS; round++) {
        const batch: { orderId: string; paymentId: string }[] = [];
        for (let i = 0; i < ORDERS_PER_ROUND; i++) {
          const order = await placeOrder([
            { variantId: a.id, quantity: 1 },
            { variantId: b.id, quantity: 1 },
          ]);
          await createPix(order.id).expect(201);
          const { providerPaymentId } = await paymentOf(order.id);
          batch.push({ orderId: order.id, paymentId: providerPaymentId });
          ids.push(order.id);
        }
        // Prazo ainda valendo para o pagamento (aprovado agora), mas vencido para o relógio que o
        // job recebe (+31 min): os dois lados acham que podem agir.
        await ctx.db
          .update(orders)
          .set({ expiresAt: new Date(Date.now() + 5 * 60_000) })
          .where(
            inArray(
              orders.id,
              batch.map((o) => o.orderId),
            ),
          );
        for (const o of batch) approve(o.paymentId);

        const k = round % ORDERS_PER_ROUND;
        const [hooks] = await Promise.all([
          Promise.all(batch.map((o) => webhook(o.paymentId))),
          sleep(5 * k).then(() => service.releaseExpired(new Date(Date.now() + 31 * 60_000))),
        ]);
        expect(hooks.map((r) => r.status)).toEqual(Array(ORDERS_PER_ROUND).fill(200));
      }

      let paid = 0;
      for (const id of ids) {
        const status = await orderStatus(id);
        const payment = await paymentOf(id);
        expect(payment.status).toBe('APPROVED');
        if (status === 'PAID') {
          paid++;
          expect(payment.alert).toBeNull();
        } else {
          expect(status).toBe('EXPIRED');
          expect(payment.alert).toBe('PAID_AFTER_EXPIRY');
        }
      }
      expect(await stockOf(a.id)).toEqual({ stock: initialStock - paid, reserved: 0 });
      expect(await stockOf(b.id)).toEqual({ stock: initialStock - paid, reserved: 0 });
    });
  });

  describe('GET /api/orders/:id/pix (verificação sob demanda)', () => {
    it('consulta o provedor no máximo uma vez a cada 20 s por pedido, mesmo com chamadas simultâneas', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order, paymentId } = await orderWithPix(v.id);

      const results = await Promise.all(Array.from({ length: 6 }, () => getPix(order.id)));
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(getSpy).toHaveBeenCalledTimes(1);

      await getPix(order.id).expect(200);
      expect(getSpy).toHaveBeenCalledTimes(1);

      // Passados 20 s, a próxima consulta vai ao provedor; aprovado → PAID.
      await ctx.db
        .update(payments)
        .set({ lastCheckedAt: new Date(Date.now() - 21_000) })
        .where(eq(payments.orderId, order.id));
      approve(paymentId);
      const res = await getPix(order.id).expect(200);

      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(res.body).toMatchObject({ orderStatus: 'PAID', status: 'APPROVED' });
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });

      // Estado final: não consulta mais.
      await ctx.db
        .update(payments)
        .set({ lastCheckedAt: null })
        .where(eq(payments.orderId, order.id));
      await getPix(order.id).expect(200);
      expect(getSpy).toHaveBeenCalledTimes(2);
    });

    it('falha do provedor → 200 com o estado do banco', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const { order } = await orderWithPix(v.id);
      getSpy.mockRejectedValueOnce(
        new PixProviderError('Mercado Pago indisponível (tempo esgotado).'),
      );

      const res = await getPix(order.id).expect(200);

      expect(res.body).toMatchObject({
        orderId: order.id,
        orderStatus: 'PENDING_PAYMENT',
        status: 'PENDING',
        expiresAt: order.expiresAt,
      });
    });

    it('404 sem cobrança, 400 id inválido', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const order = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      await getPix(order.id).expect(404);
      await getPix(MISSING_ID).expect(404);
      await getPix('nao-e-uuid').expect(400);
    });
  });
});

describe('Pix desligado (sem variáveis do Mercado Pago)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(() => teardownTestApp(ctx));

  it('POST /pix responde 503 PIX_UNAVAILABLE e o webhook também não processa nada', async () => {
    await resetData(ctx.db);
    const product = await ctx.db.query.products.findFirst({
      where: eq(products.slug, '05-camiseta-preta'),
      with: { variants: true },
    });
    const order = await request(ctx.app.getHttpServer())
      .post('/api/orders')
      .set('X-Forwarded-For', '10.61.0.1')
      .send({ items: [{ variantId: product!.variants[0].id, quantity: 1 }], customer })
      .expect(201);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/pix`)
      .set('X-Forwarded-For', '10.61.0.2')
      .expect(503);
    expect(res.body).toEqual({
      statusCode: 503,
      code: 'PIX_UNAVAILABLE',
      message: expect.stringMatching(/indisponível/),
      error: 'Service Unavailable',
    });

    await request(ctx.app.getHttpServer())
      .post('/api/webhooks/mercadopago?data.id=1&type=payment')
      .set('X-Forwarded-For', '10.61.0.3')
      .send({ type: 'payment', data: { id: '1' } })
      .expect(503);
  });
});
