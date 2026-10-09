import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { AdminRole, OrderStatus } from '@otilc/shared';
import { AdminAuthService } from '../src/admin-auth/admin-auth.service';
import { createAdminUser } from '../src/admin-auth/new-admin';
import { SESSION_COOKIE } from '../src/admin-auth/session-token';
import { orders, products, variants } from '../src/db/schema';
import { OrdersService } from '../src/orders/orders.service';
import { resetData, setupTestApp, teardownTestApp, type TestContext } from './setup';

const WEB_ORIGIN = 'http://localhost:3000';
const PASSWORD = 'uma-senha-bem-longa';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };

describe('Admin: pedidos e mudança de status (integração com Postgres)', () => {
  let ctx: TestContext;
  let staff: string;
  // O limite geral é por IP e vive enquanto o app vive: cada requisição usa um IP próprio.
  let ipCounter = 0;
  const nextIp = () => `10.40.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  beforeEach(async () => {
    await resetData(ctx.db);
    staff = await sessionCookie('STAFF');
  });
  afterAll(() => teardownTestApp(ctx));

  /** Cria o admin e a sessão direto pelo serviço (sem passar pelo limite de login). */
  async function sessionCookie(role: AdminRole): Promise<string> {
    const email = `${role.toLowerCase()}@otilc.com.br`;
    await createAdminUser(ctx.db, { email, name: role, role, password: PASSWORD });
    const { token } = await ctx.app.get(AdminAuthService).login({ email, password: PASSWORD });
    return `${SESSION_COOKIE}=${token}`;
  }

  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string) =>
    http().get(path).set('Cookie', staff).set('X-Forwarded-For', nextIp());
  const setStatus = (id: string, status: OrderStatus | string) =>
    http()
      .patch(`/api/admin/orders/${id}/status`)
      .set('Cookie', staff)
      .set('Origin', WEB_ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send({ status });

  /** Variação da seed com o estoque pedido (a seed tem 1 unidade por variação). */
  async function variantWithStock(slug: string, stock: number) {
    const product = await ctx.db.query.products.findFirst({
      where: eq(products.slug, slug),
      with: { variants: true },
    });
    if (!product) throw new Error(`produto ${slug} ausente na seed`);
    const [v] = product.variants;
    await ctx.db.update(variants).set({ stock }).where(eq(variants.id, v.id));
    return { ...v, stock, price: product.priceCents, name: product.name };
  }

  async function placeOrder(items: { variantId: string; quantity: number }[]): Promise<string> {
    const res = await http()
      .post('/api/orders')
      .set('X-Forwarded-For', nextIp())
      .send({ items, customer })
      .expect(201);
    return res.body.id;
  }

  async function stockOf(id: string) {
    const [row] = await ctx.db
      .select({ stock: variants.stock, reserved: variants.reserved })
      .from(variants)
      .where(eq(variants.id, id));
    return row;
  }

  async function statusOf(id: string) {
    const [row] = await ctx.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, id));
    return row.status;
  }

  describe('consulta', () => {
    it('401 sem sessão', async () => {
      await http().get('/api/admin/orders').expect(401);
      await http()
        .patch(`/api/admin/orders/${MISSING_ID}/status`)
        .set('Origin', WEB_ORIGIN)
        .send({ status: 'PAID' })
        .expect(401);
    });

    it('lista do mais novo para o mais antigo, com filtro, paginação e soma das unidades', async () => {
      const a = await variantWithStock('05-camiseta-preta', 5);
      const b = await variantWithStock('07-camiseta-branca', 5);
      const first = await placeOrder([{ variantId: a.id, quantity: 2 }]);
      const second = await placeOrder([
        { variantId: a.id, quantity: 1 },
        { variantId: b.id, quantity: 3 },
      ]);
      await setStatus(first, 'PAID').expect(200);

      const all = await get('/api/admin/orders').expect(200);
      expect(all.body).toMatchObject({ page: 1, perPage: 20, total: 2, totalPages: 1 });
      expect(all.body.items.map((o: { id: string }) => o.id)).toEqual([second, first]);
      expect(all.body.items[0]).toEqual({
        id: second,
        number: expect.any(Number),
        status: 'PENDING_PAYMENT',
        customerName: customer.name,
        totalCents: a.price + b.price * 3,
        itemCount: 4,
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
      });

      const paid = await get('/api/admin/orders?status=PAID').expect(200);
      expect(paid.body.items.map((o: { id: string }) => o.id)).toEqual([first]);
      expect(paid.body.total).toBe(1);

      const page2 = await get('/api/admin/orders?pagina=2&porPagina=1').expect(200);
      expect(page2.body).toMatchObject({ page: 2, perPage: 1, total: 2, totalPages: 2 });
      expect(page2.body.items.map((o: { id: string }) => o.id)).toEqual([first]);
    });

    it('query inválida é 400', async () => {
      await get('/api/admin/orders?status=PERDIDO').expect(400);
      await get('/api/admin/orders?porPagina=101').expect(400);
      await get('/api/admin/orders?pagina=0').expect(400);
    });

    it('detalhe com contato e SKU; 400 id malformado, 404 inexistente', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const id = await placeOrder([{ variantId: v.id, quantity: 2 }]);

      const res = await get(`/api/admin/orders/${id}`).expect(200);
      expect(res.body).toEqual({
        id,
        number: expect.any(Number),
        status: 'PENDING_PAYMENT',
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        totalCents: v.price * 2,
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
        items: [
          {
            variantId: v.id,
            sku: v.sku,
            productName: v.name,
            size: v.size,
            unitPriceCents: v.price,
            quantity: 2,
          },
        ],
      });

      await get('/api/admin/orders/123').expect(400);
      await get(`/api/admin/orders/${MISSING_ID}`).expect(404);
    });
  });

  describe('PATCH /api/admin/orders/:id/status', () => {
    it('PENDING_PAYMENT → PAID vende: reserved e stock caem juntos', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const id = await placeOrder([{ variantId: v.id, quantity: 2 }]);
      expect(await stockOf(v.id)).toEqual({ stock: 3, reserved: 2 });

      const res = await setStatus(id, 'PAID').expect(200);

      expect(res.body.status).toBe('PAID');
      expect(res.body.items[0].sku).toBe(v.sku);
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
    });

    it('PENDING_PAYMENT → PAID com prazo vencido é 409, mesmo antes do job de expiração', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const id = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      await ctx.db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(orders.id, id));

      const res = await setStatus(id, 'PAID').expect(409);

      expect(res.body.message).toMatch(/prazo de pagamento/);
      expect(await statusOf(id)).toBe('PENDING_PAYMENT');
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 1 });
      // O pedido vencido ainda pode ser cancelado pelo painel (libera a reserva).
      await setStatus(id, 'CANCELED').expect(200);
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
    });

    it('PENDING_PAYMENT → CANCELED devolve as unidades reservadas de todos os itens', async () => {
      const a = await variantWithStock('05-camiseta-preta', 4);
      const b = await variantWithStock('07-camiseta-branca', 4);
      const id = await placeOrder([
        { variantId: a.id, quantity: 3 },
        { variantId: b.id, quantity: 1 },
      ]);

      await setStatus(id, 'CANCELED').expect(200);

      expect(await stockOf(a.id)).toEqual({ stock: 4, reserved: 0 });
      expect(await stockOf(b.id)).toEqual({ stock: 4, reserved: 0 });
    });

    it('PAID → CANCELED devolve as peças vendidas ao estoque', async () => {
      const a = await variantWithStock('05-camiseta-preta', 4);
      const b = await variantWithStock('07-camiseta-branca', 4);
      const id = await placeOrder([
        { variantId: a.id, quantity: 3 },
        { variantId: b.id, quantity: 1 },
      ]);
      await setStatus(id, 'PAID').expect(200);
      expect(await stockOf(a.id)).toEqual({ stock: 1, reserved: 0 });

      const res = await setStatus(id, 'CANCELED').expect(200);

      expect(res.body.status).toBe('CANCELED');
      expect(await stockOf(a.id)).toEqual({ stock: 4, reserved: 0 });
      expect(await stockOf(b.id)).toEqual({ stock: 4, reserved: 0 });
    });

    it('PAID → SHIPPED não mexe no estoque; depois disso nada mais muda', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const id = await placeOrder([{ variantId: v.id, quantity: 1 }]);
      await setStatus(id, 'PAID').expect(200);

      await setStatus(id, 'SHIPPED').expect(200);
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });

      const res = await setStatus(id, 'PAID').expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        message: 'Transição de status inválida: SHIPPED → PAID.',
        error: 'Conflict',
      });
      await setStatus(id, 'CANCELED').expect(409);
      expect(await stockOf(v.id)).toEqual({ stock: 1, reserved: 0 });
    });

    it('transições fora de canTransitionOrder são 409 e não alteram nada', async () => {
      const v = await variantWithStock('05-camiseta-preta', 2);
      const id = await placeOrder([{ variantId: v.id, quantity: 1 }]);

      await setStatus(id, 'SHIPPED').expect(409);
      await setStatus(id, 'EXPIRED').expect(409);
      await setStatus(id, 'PENDING_PAYMENT').expect(409);
      expect(await statusOf(id)).toBe('PENDING_PAYMENT');

      await setStatus(id, 'CANCELED').expect(200);
      await setStatus(id, 'PAID').expect(409);
      await setStatus(id, 'CANCELED').expect(409);
      expect(await stockOf(v.id)).toEqual({ stock: 2, reserved: 0 });
    });

    it('400 status desconhecido ou id malformado; 404 inexistente', async () => {
      await setStatus(MISSING_ID, 'ENTREGUE').expect(400);
      await setStatus('nao-e-uuid', 'PAID').expect(400);
      await setStatus(MISSING_ID, 'PAID').expect(404);
    });

    it('dois cancelamentos simultâneos de um pedido pago devolvem a peça uma vez só', async () => {
      const v = await variantWithStock('05-camiseta-preta', 3);
      const id = await placeOrder([{ variantId: v.id, quantity: 2 }]);
      await setStatus(id, 'PAID').expect(200);

      const results = await Promise.all(Array.from({ length: 5 }, () => setStatus(id, 'CANCELED')));

      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([200, 409, 409, 409, 409]);
      expect(await stockOf(v.id)).toEqual({ stock: 3, reserved: 0 });
    });

    it('painel e job de expiração ao mesmo tempo liberam a reserva uma vez só', async () => {
      const v = await variantWithStock('05-camiseta-preta', 10);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await placeOrder([{ variantId: v.id, quantity: 1 }]));
      await ctx.db
        .update(orders)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(inArray(orders.id, ids));
      // Pedido ainda no prazo: segura 1 unidade. O job usa GREATEST(..., 0), então sem ele uma
      // liberação em dobro ficaria escondida no zero.
      await placeOrder([{ variantId: v.id, quantity: 1 }]);

      const service = ctx.app.get(OrdersService);
      const [cancels] = await Promise.all([
        Promise.all(ids.map((id) => setStatus(id, 'CANCELED'))),
        service.releaseExpired(),
      ]);

      expect(cancels.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      const rows = await ctx.db
        .select({ status: orders.status })
        .from(orders)
        .where(inArray(orders.id, ids));
      expect(rows.every((r) => r.status === 'CANCELED' || r.status === 'EXPIRED')).toBe(true);
      expect(rows.filter((r) => r.status === 'CANCELED')).toHaveLength(
        cancels.filter((r) => r.status === 200).length,
      );
      expect(await stockOf(v.id)).toEqual({ stock: 10, reserved: 1 });
    });
  });
});
