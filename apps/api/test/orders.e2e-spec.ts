import { eq, inArray, sql } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { orderItems, orders, variants } from '../src/db/schema';
import { OrdersService } from '../src/orders/orders.service';
import { resetData, setupTestApp, teardownTestApp, type TestContext } from './setup';

const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };

/** Código SQLSTATE do erro do Postgres, procurando também no `cause` (a Drizzle embrulha o erro). */
function pgCode(err: unknown): string | undefined {
  for (let e = err; e instanceof Object; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Texto SQL de uma chamada a `Client.query` (string ou objeto `{ text }`). */
function queryText(call: unknown[]): string {
  const [q] = call;
  if (typeof q === 'string') return q;
  const text = (q as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

describe('Pedidos e reserva de estoque (integração com Postgres)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  beforeEach(() => resetData(ctx.db));
  afterAll(() => teardownTestApp(ctx));

  const http = () => request(ctx.app.getHttpServer());
  // O limite de pedidos é por IP e vive enquanto o app vive: os testes longos usam um IP por pedido.
  let ipCounter = 0;
  const nextIp = () => `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const postOrder = (items: { variantId: string; quantity: number }[]) =>
    http().post('/api/orders').set('X-Forwarded-For', nextIp()).send({ items, customer });

  async function placeOrder(items: { variantId: string; quantity: number }[]): Promise<string> {
    const res = await postOrder(items).expect(201);
    return res.body.id;
  }

  async function expireNow(ids: string[]): Promise<void> {
    await ctx.db
      .update(orders)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(inArray(orders.id, ids));
  }

  async function variantOf(slug: string): Promise<string> {
    const res = await http().get(`/api/products/${slug}`).expect(200);
    return res.body.variants[0].id;
  }

  it('cria o pedido com o preço do banco e reserva a unidade', async () => {
    const variantId = await variantOf('01-air-jordan-3-retro');

    const res = await http()
      .post('/api/orders')
      .send({ items: [{ variantId, quantity: 1, priceCents: 1 }], customer, totalCents: 1 })
      .expect(201);

    expect(res.body).toMatchObject({ status: 'PENDING_PAYMENT', totalCents: 70000 });
    const [v] = await ctx.db.select().from(variants).where(eq(variants.id, variantId));
    expect(v.reserved).toBe(1);

    const detail = await http().get('/api/products/01-air-jordan-3-retro').expect(200);
    expect(detail.body.status).toBe('RESERVED');
  });

  it('não vende a mesma peça duas vezes com 10 compras simultâneas', async () => {
    const variantId = await variantOf('05-camiseta-preta');

    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        http()
          .post('/api/orders')
          .set('X-Forwarded-For', `10.0.0.${i + 1}`)
          .send({ items: [{ variantId, quantity: 1 }], customer }),
      ),
    );

    const codes = attempts.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(9);

    const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)::int` }).from(orders);
    expect(total).toBe(1);
  });

  it('desfaz tudo se um dos itens não tiver estoque', async () => {
    const a = await variantOf('07-camiseta-branca');
    const b = await variantOf('08-assc-playboy');

    await http()
      .post('/api/orders')
      .send({
        items: [
          { variantId: a, quantity: 1 },
          { variantId: b, quantity: 2 },
        ],
        customer,
      })
      .expect(409);

    const rows = await ctx.db.select().from(variants);
    expect(rows.every((v) => v.reserved === 0)).toBe(true);
  });

  it('recusa variação inexistente e dados inválidos', async () => {
    await http()
      .post('/api/orders')
      .send({
        items: [{ variantId: '00000000-0000-4000-8000-000000000000', quantity: 1 }],
        customer,
      })
      .expect(422);

    const res = await http()
      .post('/api/orders')
      .send({ items: [], customer: { ...customer, email: 'invalido' } })
      .expect(400);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
      expect.arrayContaining(['items', 'customer.email']),
    );
  });

  it('libera o estoque de pedidos vencidos', async () => {
    const variantId = await variantOf('14-bone-branco');
    const created = await http()
      .post('/api/orders')
      .send({ items: [{ variantId, quantity: 1 }], customer })
      .expect(201);

    const service = ctx.app.get(OrdersService);
    const released = await service.releaseExpired(new Date(Date.now() + 31 * 60_000));
    expect(released).toBe(1);

    const order = await http().get(`/api/orders/${created.body.id}`).expect(200);
    expect(order.body.status).toBe('EXPIRED');
    const detail = await http().get('/api/products/14-bone-branco').expect(200);
    expect(detail.body.variants[0].available).toBe(1);
  });

  it('libera a variação de vários pedidos vencidos numa única atualização', async () => {
    const variantId = await variantOf('05-camiseta-preta');
    await ctx.db.update(variants).set({ stock: 6 }).where(eq(variants.id, variantId));
    const first = await placeOrder([{ variantId, quantity: 1 }]);
    const second = await placeOrder([{ variantId, quantity: 2 }]);
    await expireNow([first, second]);
    // Pedido ainda no prazo: segura 1 unidade, para o GREATEST(..., 0) do job não esconder erro.
    await placeOrder([{ variantId, quantity: 1 }]);

    // Conta os UPDATE em variants que o job manda ao Postgres (lido antes do mockRestore, que
    // limpa as chamadas registradas).
    const queries = jest.spyOn(Client.prototype, 'query');
    let released: number;
    let variantUpdates: string[];
    try {
      released = await ctx.app.get(OrdersService).releaseExpired();
      variantUpdates = queries.mock.calls
        .map((call) => queryText(call))
        .filter((text) => /^update "variants"/i.test(text));
    } finally {
      queries.mockRestore();
    }

    expect(released).toBe(2);
    expect(variantUpdates).toHaveLength(1);
    const [v] = await ctx.db.select().from(variants).where(eq(variants.id, variantId));
    expect(v).toMatchObject({ stock: 6, reserved: 1 });
  });

  it('job de expiração e checkout ao mesmo tempo não entram em deadlock (estresse)', async () => {
    const [low, high] = [
      await variantOf('05-camiseta-preta'),
      await variantOf('07-camiseta-branca'),
    ].sort((a, b) => a.localeCompare(b));
    const service = ctx.app.get(OrdersService);
    const ROUNDS = 30;
    const failures: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      // Estoque folgado: as reservas vencidas e o checkout cabem, então o checkout chega a travar
      // as duas linhas (low e depois high) em vez de parar no 409 da primeira.
      await ctx.db
        .update(variants)
        .set({ stock: sql`${variants.reserved} + 3` })
        .where(inArray(variants.id, [low, high]));
      // Pedido 1 (maior id) criado antes do pedido 2 (menor id): o SELECT dos itens no job tende
      // a devolver high antes de low, a ordem contrária à do checkout.
      const first = await placeOrder([{ variantId: high, quantity: 1 }]);
      const second = await placeOrder([{ variantId: low, quantity: 1 }]);
      await expireNow([first, second]);

      const [job, checkout] = await Promise.allSettled([
        service.releaseExpired(),
        postOrder([
          { variantId: low, quantity: 1 },
          { variantId: high, quantity: 1 },
        ]),
      ]);

      if (job.status === 'rejected') {
        failures.push(`rodada ${round}: job falhou (${pgCode(job.reason) ?? String(job.reason)})`);
      }
      if (checkout.status === 'rejected') {
        failures.push(`rodada ${round}: checkout rejeitado (${String(checkout.reason)})`);
      } else if (
        checkout.value.status !== 201 &&
        !(
          checkout.value.status === 409 && /^Estoque insuficiente/.test(checkout.value.body.message)
        )
      ) {
        failures.push(`rodada ${round}: checkout respondeu ${checkout.value.status}`);
      }
    }

    expect(failures).toEqual([]);

    // reserved de cada variação = soma dos itens dos pedidos que ainda esperam pagamento.
    const pending = await ctx.db
      .select({
        variantId: orderItems.variantId,
        total: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orders.status, 'PENDING_PAYMENT'))
      .groupBy(orderItems.variantId);
    const pendingOf = new Map(pending.map((p) => [p.variantId, p.total]));
    const rows = await ctx.db
      .select({ id: variants.id, reserved: variants.reserved })
      .from(variants)
      .where(inArray(variants.id, [low, high]));
    for (const row of rows) expect(row.reserved).toBe(pendingOf.get(row.id) ?? 0);
  }, 120_000);
});
