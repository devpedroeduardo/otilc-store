import request from 'supertest';
import { setupTestApp, teardownTestApp, type TestContext } from './setup';

describe('Catálogo (integração com Postgres)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(() => teardownTestApp(ctx));

  const http = () => request(ctx.app.getHttpServer());

  it('GET /api/health confirma API e banco', async () => {
    await http().get('/api/health').expect(200, { status: 'ok', database: 'ok' });
  });

  it('lista as categorias na ordem do drop', async () => {
    const res = await http().get('/api/categories').expect(200);
    expect(res.body.map((c: { slug: string }) => c.slug)).toEqual([
      'tenis',
      'camisetas',
      'calcas',
      'casacos',
      'bones',
    ]);
  });

  it('pagina o catálogo e informa o total', async () => {
    const res = await http().get('/api/products?porPagina=5&pagina=2').expect(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body).toMatchObject({ page: 2, perPage: 5, total: 17, totalPages: 4 });
  });

  it('filtra por categoria e ordena por menor preço', async () => {
    const res = await http().get('/api/products?categoria=tenis&ordem=menor-preco').expect(200);
    const prices = res.body.items.map((p: { priceCents: number }) => p.priceCents);
    expect(prices).toEqual([18000, 25000, 70000]);
  });

  it('mostra o detalhe com variações e condição numérica', async () => {
    const res = await http().get('/api/products/02-streetball').expect(200);
    expect(res.body).toMatchObject({ name: 'Streetball', condition: 7.5, priceCents: 25000 });
    expect(res.body.variants[0]).toMatchObject({ size: 'Único', available: 1 });
  });

  it('responde 404 para produto inexistente', async () => {
    await http().get('/api/products/nao-existe').expect(404);
  });

  it('recusa filtros malformados com 400', async () => {
    const res = await http().get("/api/products?categoria=x' OR 1=1").expect(400);
    expect(res.body.errors[0].field).toBe('categoria');
  });
});
