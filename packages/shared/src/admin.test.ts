import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminActions,
  adminLoginSchema,
  adminOrderQuerySchema,
  adminOrderStatusUpdateSchema,
  adminProductInputSchema,
  adminProductPatchSchema,
  adminStockUpdateSchema,
  adminVariantInputSchema,
  canRole,
  canTransitionOrder,
  orderStatusSchema,
  type AdminAction,
} from './admin';

const product = {
  slug: 'camiseta-veja-alem',
  name: 'Camiseta Veja Além',
  priceCents: 12990,
  condition: null,
  status: 'ACTIVE',
  featured: false,
  categorySlug: 'camisetas',
};

test('login normaliza o e-mail com espaços e maiúsculas', () => {
  const parsed = adminLoginSchema.parse({
    email: '  Ana.Souza@Example.COM ',
    password: 'senha-bem-longa',
  });
  assert.equal(parsed.email, 'ana.souza@example.com');
});

test('login recusa senha curta, senha longa demais e e-mail inválido', () => {
  const email = 'ana@example.com';
  assert.equal(adminLoginSchema.safeParse({ email, password: '12345678901' }).success, false);
  assert.equal(adminLoginSchema.safeParse({ email, password: '123456789012' }).success, true);
  assert.equal(adminLoginSchema.safeParse({ email, password: 'a'.repeat(201) }).success, false);
  assert.equal(
    adminLoginSchema.safeParse({ email: 'nao-e-email', password: 'senha-bem-longa' }).success,
    false,
  );
});

test('OWNER pode todas as ações', () => {
  for (const action of adminActions) assert.equal(canRole('OWNER', action), true, action);
});

test('STAFF só consulta, ajusta estoque e muda status de pedido', () => {
  const allowed: Record<AdminAction, boolean> = {
    'product:read': true,
    'product:create': false,
    'product:update': false,
    'variant:create': false,
    'stock:update': true,
    'order:read': true,
    'order:updateStatus': true,
  };
  // Garante que a tabela acima cobre toda ação nova adicionada a `adminActions`.
  assert.deepEqual(Object.keys(allowed).sort(), [...adminActions].sort());
  for (const action of adminActions)
    assert.equal(canRole('STAFF', action), allowed[action], action);
});

test('papel ou ação desconhecidos não têm permissão', () => {
  assert.equal(canRole('ADMIN' as never, 'product:read'), false);
  assert.equal(canRole('OWNER', 'user:delete' as never), false);
});

test('transições de pedido permitidas', () => {
  const allowed = new Set([
    'PENDING_PAYMENT>PAID',
    'PENDING_PAYMENT>CANCELED',
    'PAID>SHIPPED',
    'PAID>CANCELED',
  ]);
  for (const from of orderStatusSchema.options)
    for (const to of orderStatusSchema.options)
      assert.equal(canTransitionOrder(from, to), allowed.has(`${from}>${to}`), `${from} → ${to}`);
});

test('produto: recusa preço zero, negativo ou fracionado', () => {
  for (const priceCents of [0, -100, 10.5])
    assert.equal(adminProductInputSchema.safeParse({ ...product, priceCents }).success, false);
  assert.equal(adminProductInputSchema.safeParse(product).success, true);
});

test('produto: recusa slug inválido e condição fora da faixa', () => {
  assert.equal(
    adminProductInputSchema.safeParse({ ...product, slug: 'Camiseta X' }).success,
    false,
  );
  assert.equal(adminProductInputSchema.safeParse({ ...product, condition: 11 }).success, false);
  assert.equal(adminProductInputSchema.safeParse({ ...product, condition: 7.5 }).success, true);
});

test('edição parcial aceita só um campo, mas mantém as regras', () => {
  assert.deepEqual(adminProductPatchSchema.parse({ name: 'Novo nome' }), { name: 'Novo nome' });
  assert.equal(adminProductPatchSchema.safeParse({ priceCents: 0 }).success, false);
});

test('edição parcial recusa corpo vazio', () => {
  assert.equal(adminProductPatchSchema.safeParse({}).success, false);
  assert.equal(adminProductPatchSchema.safeParse({ name: undefined }).success, false);
  assert.equal(adminProductPatchSchema.safeParse({ campoDesconhecido: 1 }).success, false);
  assert.equal(adminProductPatchSchema.safeParse({ featured: false }).success, true);
  assert.equal(adminProductPatchSchema.safeParse({ brand: null }).success, true);
});

test('variação e estoque recusam estoque negativo ou fracionado', () => {
  const variant = { sku: 'CAM-VA-P', size: 'P', stock: 3 };
  assert.equal(adminVariantInputSchema.safeParse(variant).success, true);
  assert.equal(adminVariantInputSchema.safeParse({ ...variant, stock: -1 }).success, false);
  assert.equal(adminStockUpdateSchema.safeParse({ stock: 0 }).success, true);
  assert.equal(adminStockUpdateSchema.safeParse({ stock: -1 }).success, false);
  assert.equal(adminStockUpdateSchema.safeParse({ stock: 1.5 }).success, false);
});

test('consulta de pedidos converte a paginação e valida o status', () => {
  assert.deepEqual(adminOrderQuerySchema.parse({}), { pagina: 1, porPagina: 20 });
  assert.deepEqual(adminOrderQuerySchema.parse({ status: 'PAID', pagina: '2' }), {
    status: 'PAID',
    pagina: 2,
    porPagina: 20,
  });
  assert.equal(adminOrderQuerySchema.safeParse({ status: 'paid' }).success, false);
  assert.equal(adminOrderStatusUpdateSchema.safeParse({ status: 'REFUNDED' }).success, false);
});
