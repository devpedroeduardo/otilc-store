import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { AdminRole } from '@otilc/shared';
import { AdminAuthService } from '../src/admin-auth/admin-auth.service';
import { createAdminUser } from '../src/admin-auth/new-admin';
import { SESSION_COOKIE } from '../src/admin-auth/session-token';
import { orderItems, products, variants } from '../src/db/schema';
import { resetData, setupTestApp, teardownTestApp, type TestContext } from './setup';

const WEB_ORIGIN = 'http://localhost:3000';
const PASSWORD = randomBytes(24).toString('base64url');
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };

const newProduct = {
  slug: 'camiseta-veja-alem',
  name: 'Camiseta Veja Além',
  brand: 'OTILC',
  description: 'Algodão 100%.',
  priceCents: 12990,
  condition: null,
  status: 'DRAFT',
  featured: false,
  categorySlug: 'camisetas',
};

describe('Admin: produtos, variações e estoque (integração com Postgres)', () => {
  let ctx: TestContext;
  let owner: string;
  let staff: string;
  // O limite geral é por IP e vive enquanto o app vive: cada requisição usa um IP próprio.
  let ipCounter = 0;
  const nextIp = () => `10.30.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  beforeEach(async () => {
    await resetData(ctx.db);
    owner = await sessionCookie('OWNER');
    staff = await sessionCookie('STAFF');
  });
  afterAll(() => teardownTestApp(ctx));

  /** Cria o admin e a sessão direto pelo serviço (sem passar pelo limite de login). */
  async function sessionCookie(role: AdminRole): Promise<string> {
    const email = `${role.toLowerCase()}@example.test`;
    await createAdminUser(ctx.db, { email, name: role, role, password: PASSWORD });
    const { token } = await ctx.app.get(AdminAuthService).login({ email, password: PASSWORD });
    return `${SESSION_COOKIE}=${token}`;
  }

  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string, cookie: string) =>
    http().get(path).set('Cookie', cookie).set('X-Forwarded-For', nextIp());
  const send = (method: 'post' | 'patch' | 'put', path: string, cookie: string, body: object) =>
    http()
      [method](path)
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send(body);

  async function productBySlug(slug: string) {
    const product = await ctx.db.query.products.findFirst({
      where: eq(products.slug, slug),
      with: { variants: true },
    });
    if (!product) throw new Error(`produto ${slug} ausente na seed`);
    return product;
  }

  async function variantRow(id: string) {
    const [row] = await ctx.db.select().from(variants).where(eq(variants.id, id));
    return row;
  }

  function checkout(variantId: string, quantity = 1) {
    return http()
      .post('/api/orders')
      .set('X-Forwarded-For', nextIp())
      .send({ items: [{ variantId, quantity }], customer });
  }

  describe('autenticação e papéis', () => {
    it('401 sem sessão', async () => {
      await http().get('/api/admin/products').expect(401);
      await http()
        .post('/api/admin/products')
        .set('Origin', WEB_ORIGIN)
        .send(newProduct)
        .expect(401);
    });

    it('403 em mutação sem Origin da loja', async () => {
      await http()
        .post('/api/admin/products')
        .set('Cookie', owner)
        .set('Origin', 'https://evil.example')
        .send(newProduct)
        .expect(403);
    });
  });

  describe('GET /api/admin/products', () => {
    it('lista todos, inclusive rascunhos, do mais novo para o mais antigo (STAFF pode)', async () => {
      const draft = await send('post', '/api/admin/products', owner, newProduct).expect(201);

      const res = await get('/api/admin/products', staff).expect(200);

      expect(res.body[0].id).toBe(draft.body.id);
      expect(res.body[0].status).toBe('DRAFT');
      const created = res.body.map((p: { createdAt: string }) => p.createdAt);
      expect(created).toEqual([...created].sort().reverse());
      const total = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(products);
      expect(res.body).toHaveLength(total[0].n);
    });

    it('detalhe com estoque e reservado; 400 para id malformado e 404 inexistente', async () => {
      const seeded = await productBySlug('05-camiseta-preta');
      const variantId = seeded.variants[0].id;
      await checkout(variantId).expect(201);

      const res = await get(`/api/admin/products/${seeded.id}`, staff).expect(200);
      expect(res.body).toMatchObject({
        id: seeded.id,
        slug: '05-camiseta-preta',
        status: 'ACTIVE',
        category: { slug: expect.any(String), name: expect.any(String) },
        variants: [{ id: variantId, stock: 1, reserved: 1 }],
      });
      expect(typeof res.body.createdAt).toBe('string');

      await get('/api/admin/products/nao-e-uuid', staff).expect(400);
      await get(`/api/admin/products/${MISSING_ID}`, staff).expect(404);
    });
  });

  describe('POST /api/admin/products', () => {
    it('OWNER cria o produto sem variações e campos desconhecidos são descartados', async () => {
      const res = await send('post', '/api/admin/products', owner, {
        ...newProduct,
        condition: 9.5,
        id: MISSING_ID,
      }).expect(201);

      expect(res.body).toMatchObject({
        slug: newProduct.slug,
        priceCents: 12990,
        condition: 9.5,
        note: null,
        status: 'DRAFT',
        category: { slug: 'camisetas', name: 'Camisetas' },
        images: [],
        variants: [],
      });
      expect(res.body.id).not.toBe(MISSING_ID);
    });

    it('STAFF não cria produto (403) e nada é gravado', async () => {
      await send('post', '/api/admin/products', staff, newProduct).expect(403);
      const found = await ctx.db.query.products.findFirst({
        where: eq(products.slug, newProduct.slug),
      });
      expect(found).toBeUndefined();
    });

    it('slug duplicado é 409 com mensagem clara', async () => {
      const res = await send('post', '/api/admin/products', owner, {
        ...newProduct,
        slug: '05-camiseta-preta',
      }).expect(409);
      expect(res.body.message).toBe('Já existe um produto com este slug.');
    });

    it('categoria inexistente é 422; corpo inválido é 400 com a lista de campos', async () => {
      await send('post', '/api/admin/products', owner, {
        ...newProduct,
        categorySlug: 'nao-existe',
      }).expect(422);

      const res = await send('post', '/api/admin/products', owner, {
        ...newProduct,
        priceCents: 0,
        slug: 'Com Espaço',
      }).expect(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
        expect.arrayContaining(['priceCents', 'slug']),
      );
    });
  });

  describe('PATCH /api/admin/products/:id', () => {
    it('OWNER muda preço e destaque; updatedAt avança', async () => {
      const seeded = await productBySlug('05-camiseta-preta');

      const res = await send('patch', `/api/admin/products/${seeded.id}`, owner, {
        priceCents: 9990,
        featured: true,
      }).expect(200);

      expect(res.body).toMatchObject({ priceCents: 9990, featured: true, name: seeded.name });
      expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(seeded.updatedAt.getTime());
    });

    it('STAFF não muda preço (403) e o preço continua o mesmo', async () => {
      const seeded = await productBySlug('05-camiseta-preta');

      await send('patch', `/api/admin/products/${seeded.id}`, staff, { priceCents: 1 }).expect(403);

      expect((await productBySlug('05-camiseta-preta')).priceCents).toBe(seeded.priceCents);
    });

    it('400 corpo vazio, 404 inexistente, 409 slug usado, 422 categoria inexistente', async () => {
      const seeded = await productBySlug('05-camiseta-preta');
      const path = `/api/admin/products/${seeded.id}`;

      await send('patch', path, owner, {}).expect(400);
      await send('patch', path, owner, { desconhecido: 1 }).expect(400);
      await send('patch', `/api/admin/products/${MISSING_ID}`, owner, { featured: true }).expect(
        404,
      );
      const dup = await send('patch', path, owner, { slug: '07-camiseta-branca' }).expect(409);
      expect(dup.body.message).toBe('Já existe um produto com este slug.');
      await send('patch', path, owner, { categorySlug: 'nao-existe' }).expect(422);
    });

    it('mudança de preço não altera pedidos antigos', async () => {
      const seeded = await productBySlug('05-camiseta-preta');
      const order = await checkout(seeded.variants[0].id).expect(201);

      await send('patch', `/api/admin/products/${seeded.id}`, owner, {
        priceCents: seeded.priceCents * 3,
      }).expect(200);

      const after = await http().get(`/api/orders/${order.body.id}`).expect(200);
      expect(after.body.totalCents).toBe(seeded.priceCents);
      expect(after.body.items[0].unitPriceCents).toBe(seeded.priceCents);
      const [item] = await ctx.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.body.id));
      expect(item.unitPriceCents).toBe(seeded.priceCents);
    });
  });

  describe('POST /api/admin/products/:id/variants', () => {
    it('OWNER cria a variação; STAFF recebe 403', async () => {
      const seeded = await productBySlug('05-camiseta-preta');
      const path = `/api/admin/products/${seeded.id}/variants`;

      const res = await send('post', path, owner, {
        sku: 'CAM-VA-M',
        size: 'M',
        color: 'Preto',
        stock: 3,
      }).expect(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        sku: 'CAM-VA-M',
        size: 'M',
        color: 'Preto',
        stock: 3,
        reserved: 0,
      });

      await send('post', path, staff, { sku: 'CAM-VA-G', size: 'G', stock: 1 }).expect(403);
    });

    it('404 produto inexistente; 409 SKU já usado', async () => {
      await send('post', `/api/admin/products/${MISSING_ID}/variants`, owner, {
        sku: 'X-1',
        size: 'M',
        stock: 1,
      }).expect(404);

      const seeded = await productBySlug('05-camiseta-preta');
      const res = await send('post', `/api/admin/products/${seeded.id}/variants`, owner, {
        sku: seeded.variants[0].sku,
        size: 'XG',
        stock: 1,
      }).expect(409);
      expect(res.body.message).toBe('Já existe uma variação com este SKU.');
    });

    it('mesmo tamanho e cor no produto é 409, inclusive com cor nula', async () => {
      const seeded = await productBySlug('05-camiseta-preta');
      const path = `/api/admin/products/${seeded.id}/variants`;
      const message = 'Este produto já tem uma variação com este tamanho e cor.';

      await send('post', path, owner, { sku: 'A-1', size: 'G', color: 'Preto', stock: 1 }).expect(
        201,
      );
      const colored = await send('post', path, owner, {
        sku: 'A-2',
        size: 'G',
        color: 'Preto',
        stock: 1,
      }).expect(409);
      expect(colored.body.message).toBe(message);

      // Cor diferente e cor nula convivem com a variação preta.
      await send('post', path, owner, { sku: 'A-3', size: 'G', color: 'Branco', stock: 1 }).expect(
        201,
      );
      await send('post', path, owner, { sku: 'A-4', size: 'G', stock: 1 }).expect(201);
      const nullColor = await send('post', path, owner, {
        sku: 'A-5',
        size: 'G',
        color: null,
        stock: 1,
      }).expect(409);
      expect(nullColor.body.message).toBe(message);
    });

    it('o banco recusa variação duplicada com cor nula mesmo fora da API (NULLS NOT DISTINCT)', async () => {
      const seeded = await productBySlug('05-camiseta-preta');
      const base = { productId: seeded.id, size: 'GG', color: null, stock: 1 };
      await ctx.db.insert(variants).values({ ...base, sku: 'DB-1' });
      await expect(ctx.db.insert(variants).values({ ...base, sku: 'DB-2' })).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'variants_product_size_color_idx' },
      });
    });
  });

  describe('PUT /api/admin/variants/:id/stock', () => {
    it('STAFF define o estoque total (não é incremento)', async () => {
      const {
        variants: [v],
      } = await productBySlug('05-camiseta-preta');

      const res = await send('put', `/api/admin/variants/${v.id}/stock`, staff, {
        stock: 4,
      }).expect(200);
      expect(res.body).toEqual({
        id: v.id,
        sku: v.sku,
        size: v.size,
        color: v.color,
        stock: 4,
        reserved: 0,
      });
      await send('put', `/api/admin/variants/${v.id}/stock`, staff, { stock: 2 }).expect(200);
      expect((await variantRow(v.id)).stock).toBe(2);
    });

    it('abaixo do reservado é 409 e nada muda', async () => {
      const {
        variants: [v],
      } = await productBySlug('05-camiseta-preta');
      await send('put', `/api/admin/variants/${v.id}/stock`, owner, { stock: 5 }).expect(200);
      await checkout(v.id, 3).expect(201);

      const res = await send('put', `/api/admin/variants/${v.id}/stock`, staff, {
        stock: 2,
      }).expect(409);
      expect(res.body.message).toBe('O estoque não pode ficar abaixo das 3 unidades reservadas.');
      expect(await variantRow(v.id)).toMatchObject({ stock: 5, reserved: 3 });

      // Igual ao reservado é permitido: nenhuma unidade livre, nenhuma reserva perdida.
      await send('put', `/api/admin/variants/${v.id}/stock`, staff, { stock: 3 }).expect(200);
    });

    it('400 id malformado ou estoque inválido; 404 variação inexistente', async () => {
      const {
        variants: [v],
      } = await productBySlug('05-camiseta-preta');
      await send('put', '/api/admin/variants/x/stock', staff, { stock: 1 }).expect(400);
      await send('put', `/api/admin/variants/${v.id}/stock`, staff, { stock: -1 }).expect(400);
      await send('put', `/api/admin/variants/${v.id}/stock`, staff, { stock: 1.5 }).expect(400);
      await send('put', `/api/admin/variants/${MISSING_ID}/stock`, staff, { stock: 1 }).expect(404);
    });

    it('estoque e checkout simultâneos nunca deixam reserved > stock', async () => {
      const {
        variants: [v],
      } = await productBySlug('05-camiseta-preta');

      for (let round = 0; round < 5; round++) {
        await ctx.db.execute(sql`TRUNCATE order_items, orders`);
        await ctx.db.update(variants).set({ stock: 10, reserved: 0 }).where(eq(variants.id, v.id));

        const orders = Array.from({ length: 10 }, () => checkout(v.id));
        const stockUpdates = [2, 4, 6, 8, 3, 5].map((stock) =>
          send('put', `/api/admin/variants/${v.id}/stock`, staff, { stock }),
        );
        const [orderResults, stockResults] = await Promise.all([
          Promise.all(orders),
          Promise.all(stockUpdates),
        ]);

        // Nenhum 500: o CHECK do banco nunca precisou barrar nada.
        expect(orderResults.every((r) => r.status === 201 || r.status === 409)).toBe(true);
        expect(stockResults.every((r) => r.status === 200 || r.status === 409)).toBe(true);
        for (const r of stockResults.filter((s) => s.status === 200)) {
          expect(r.body.reserved).toBeLessThanOrEqual(r.body.stock);
        }

        const row = await variantRow(v.id);
        const placed = orderResults.filter((r) => r.status === 201).length;
        expect(row.reserved).toBe(placed);
        expect(row.reserved).toBeLessThanOrEqual(row.stock);
      }
    });
  });
});
