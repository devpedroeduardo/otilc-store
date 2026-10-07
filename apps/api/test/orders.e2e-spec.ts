import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { orders, variants } from '../src/db/schema';
import { OrdersService } from '../src/orders/orders.service';
import { resetData, setupTestApp, teardownTestApp, type TestContext } from './setup';

const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };

describe('Pedidos e reserva de estoque (integração com Postgres)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  beforeEach(() => resetData(ctx.db));
  afterAll(() => teardownTestApp(ctx));

  const http = () => request(ctx.app.getHttpServer());

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
});
