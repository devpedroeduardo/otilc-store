import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminLoginSchema,
  adminOrderQuerySchema,
  adminOrderStatusUpdateSchema,
  adminProductInputSchema,
  adminProductPatchSchema,
  adminStockUpdateSchema,
  adminVariantInputSchema,
  catalogQuerySchema,
  checkoutSchema,
} from './index';

/**
 * Mensagens de validação que a API devolve em `errors[]` (ZodValidationPipe) e que a loja mostra.
 * São parte do contrato: estes textos foram capturados com o Zod 3 e não podem mudar com a
 * atualização de versão do Zod (spec-011). Mudou uma mensagem? É mudança de contrato, não de teste.
 */

const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };
const item = { variantId: 'v1', quantity: 1 };
const product = {
  slug: 'camiseta-veja-alem',
  name: 'Camiseta Veja Além',
  priceCents: 12990,
  condition: null,
  status: 'ACTIVE',
  featured: false,
  categorySlug: 'camisetas',
};
const variant = { sku: 'CAM-VA-P', size: 'P', stock: 3 };
const login = { email: 'ana@example.com', password: 'teste-senha-longa' };

interface Schema {
  safeParse(input: unknown): {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
}

const cases: [
  name: string,
  schema: Schema,
  input: unknown,
  errors: { field: string; message: string }[],
][] = [
  [
    'checkout: corpo nulo',
    checkoutSchema,
    null,
    [{ field: '', message: 'Expected object, received null' }],
  ],
  [
    'checkout: corpo lista',
    checkoutSchema,
    [],
    [{ field: '', message: 'Expected object, received array' }],
  ],
  [
    'checkout: corpo texto',
    checkoutSchema,
    'x',
    [{ field: '', message: 'Expected object, received string' }],
  ],
  [
    'checkout: corpo vazio',
    checkoutSchema,
    {},
    [
      { field: 'items', message: 'Required' },
      { field: 'customer', message: 'Required' },
    ],
  ],
  [
    'checkout: carrinho vazio',
    checkoutSchema,
    { items: [], customer },
    [{ field: 'items', message: 'O carrinho está vazio.' }],
  ],
  [
    'checkout: carrinho grande demais',
    checkoutSchema,
    { items: Array(31).fill(item), customer },
    [{ field: 'items', message: 'Array must contain at most 30 element(s)' }],
  ],
  [
    'checkout: items não é lista',
    checkoutSchema,
    { items: 'a', customer },
    [{ field: 'items', message: 'Expected array, received string' }],
  ],
  [
    'checkout: item com campos vazios e quantidade zero',
    checkoutSchema,
    { items: [{ variantId: '', quantity: 0 }], customer },
    [
      { field: 'items.0.variantId', message: 'String must contain at least 1 character(s)' },
      { field: 'items.0.quantity', message: 'Number must be greater than or equal to 1' },
    ],
  ],
  [
    'checkout: item sem campos',
    checkoutSchema,
    { items: [{}], customer },
    [
      { field: 'items.0.variantId', message: 'Required' },
      { field: 'items.0.quantity', message: 'Required' },
    ],
  ],
  [
    'checkout: quantidade acima do limite, fracionada e texto',
    checkoutSchema,
    {
      items: [
        { ...item, quantity: 11 },
        { ...item, quantity: 1.5 },
        { ...item, quantity: '2' },
      ],
      customer,
    },
    [
      { field: 'items.0.quantity', message: 'Number must be less than or equal to 10' },
      { field: 'items.1.quantity', message: 'Expected integer, received float' },
      { field: 'items.2.quantity', message: 'Expected number, received string' },
    ],
  ],
  [
    'checkout: variantId longo demais e numérico',
    checkoutSchema,
    {
      items: [
        { ...item, variantId: 'v'.repeat(65) },
        { ...item, variantId: 7 },
      ],
      customer,
    },
    [
      { field: 'items.0.variantId', message: 'String must contain at most 64 character(s)' },
      { field: 'items.1.variantId', message: 'Expected string, received number' },
    ],
  ],
  [
    'checkout: cliente com campos inválidos',
    checkoutSchema,
    { items: [item], customer: { name: ' A ', email: 'x', phone: '123' } },
    [
      { field: 'customer.name', message: 'String must contain at least 2 character(s)' },
      { field: 'customer.email', message: 'E-mail inválido.' },
      { field: 'customer.phone', message: 'Telefone inválido.' },
    ],
  ],
  [
    'checkout: cliente com campos longos demais',
    checkoutSchema,
    {
      items: [item],
      customer: { ...customer, name: 'a'.repeat(121), email: 'a'.repeat(150) + '@example.com' },
    },
    [
      { field: 'customer.name', message: 'String must contain at most 120 character(s)' },
      { field: 'customer.email', message: 'String must contain at most 160 character(s)' },
    ],
  ],
  [
    'checkout: cliente nulo',
    checkoutSchema,
    { items: [item], customer: null },
    [{ field: 'customer', message: 'Expected object, received null' }],
  ],
  [
    'checkout: cliente com tipos errados',
    checkoutSchema,
    { items: [item], customer: { name: 1, email: true, phone: [] } },
    [
      { field: 'customer.name', message: 'Expected string, received number' },
      { field: 'customer.email', message: 'Expected string, received boolean' },
      { field: 'customer.phone', message: 'Expected string, received array' },
    ],
  ],
  [
    'catálogo: categoria inválida',
    catalogQuerySchema,
    { categoria: 'ABC' },
    [{ field: 'categoria', message: 'Categoria inválida.' }],
  ],
  [
    'catálogo: categoria longa demais',
    catalogQuerySchema,
    { categoria: 'a'.repeat(41) },
    [{ field: 'categoria', message: 'String must contain at most 40 character(s)' }],
  ],
  [
    'catálogo: categoria repetida na query',
    catalogQuerySchema,
    { categoria: ['a', 'b'] },
    [{ field: 'categoria', message: 'Expected string, received array' }],
  ],
  [
    'catálogo: ordem desconhecida',
    catalogQuerySchema,
    { ordem: 'x' },
    [
      {
        field: 'ordem',
        message:
          "Invalid enum value. Expected 'destaque' | 'menor-preco' | 'maior-preco' | 'novidades', received 'x'",
      },
    ],
  ],
  [
    'catálogo: ordem numérica',
    catalogQuerySchema,
    { ordem: 1 },
    [
      {
        field: 'ordem',
        message:
          "Expected 'destaque' | 'menor-preco' | 'maior-preco' | 'novidades', received number",
      },
    ],
  ],
  [
    'catálogo: página não numérica',
    catalogQuerySchema,
    { pagina: 'abc' },
    [{ field: 'pagina', message: 'Expected number, received nan' }],
  ],
  [
    'catálogo: página zero',
    catalogQuerySchema,
    { pagina: '0' },
    [{ field: 'pagina', message: 'Number must be greater than or equal to 1' }],
  ],
  [
    'catálogo: página acima do limite',
    catalogQuerySchema,
    { pagina: '501' },
    [{ field: 'pagina', message: 'Number must be less than or equal to 500' }],
  ],
  [
    'catálogo: página fracionada',
    catalogQuerySchema,
    { pagina: '1.5' },
    [{ field: 'pagina', message: 'Expected integer, received float' }],
  ],
  [
    'catálogo: porPagina acima do limite',
    catalogQuerySchema,
    { porPagina: '49' },
    [{ field: 'porPagina', message: 'Number must be less than or equal to 48' }],
  ],
  [
    'login: corpo vazio',
    adminLoginSchema,
    {},
    [
      { field: 'email', message: 'Required' },
      { field: 'password', message: 'Required' },
    ],
  ],
  [
    'login: e-mail e senha inválidos',
    adminLoginSchema,
    { email: 'nao-e-email', password: 'curta' },
    [
      { field: 'email', message: 'E-mail inválido.' },
      { field: 'password', message: 'A senha precisa ter ao menos 12 caracteres.' },
    ],
  ],
  [
    'login: senha longa demais',
    adminLoginSchema,
    { ...login, password: 'a'.repeat(201) },
    [{ field: 'password', message: 'String must contain at most 200 character(s)' }],
  ],
  [
    'login: e-mail longo demais',
    adminLoginSchema,
    { ...login, email: 'a'.repeat(150) + '@example.com' },
    [{ field: 'email', message: 'String must contain at most 160 character(s)' }],
  ],
  [
    'login: tipos errados',
    adminLoginSchema,
    { email: 1, password: null },
    [
      { field: 'email', message: 'Expected string, received number' },
      { field: 'password', message: 'Expected string, received null' },
    ],
  ],
  [
    'produto: corpo vazio',
    adminProductInputSchema,
    {},
    [
      { field: 'slug', message: 'Required' },
      { field: 'name', message: 'Required' },
      { field: 'priceCents', message: 'Required' },
      { field: 'condition', message: 'Required' },
      { field: 'status', message: 'Required' },
      { field: 'featured', message: 'Required' },
      { field: 'categorySlug', message: 'Required' },
    ],
  ],
  [
    'produto: preço zero',
    adminProductInputSchema,
    { ...product, priceCents: 0 },
    [{ field: 'priceCents', message: 'Number must be greater than 0' }],
  ],
  [
    'produto: preço negativo',
    adminProductInputSchema,
    { ...product, priceCents: -1 },
    [{ field: 'priceCents', message: 'Number must be greater than 0' }],
  ],
  [
    'produto: preço fracionado',
    adminProductInputSchema,
    { ...product, priceCents: 10.5 },
    [{ field: 'priceCents', message: 'Expected integer, received float' }],
  ],
  [
    'produto: preço acima do limite',
    adminProductInputSchema,
    { ...product, priceCents: 100_000_001 },
    [{ field: 'priceCents', message: 'Number must be less than or equal to 100000000' }],
  ],
  [
    'produto: preço texto',
    adminProductInputSchema,
    { ...product, priceCents: '100' },
    [{ field: 'priceCents', message: 'Expected number, received string' }],
  ],
  [
    'produto: condição acima de 10',
    adminProductInputSchema,
    { ...product, condition: 11 },
    [{ field: 'condition', message: 'Number must be less than or equal to 10' }],
  ],
  [
    'produto: condição negativa',
    adminProductInputSchema,
    { ...product, condition: -1 },
    [{ field: 'condition', message: 'Number must be greater than or equal to 0' }],
  ],
  [
    'produto: condição com duas casas',
    adminProductInputSchema,
    { ...product, condition: 7.55 },
    [{ field: 'condition', message: 'Number must be a multiple of 0.1' }],
  ],
  [
    'produto: condição texto',
    adminProductInputSchema,
    { ...product, condition: '7' },
    [{ field: 'condition', message: 'Expected number, received string' }],
  ],
  [
    'produto: status desconhecido',
    adminProductInputSchema,
    { ...product, status: 'X' },
    [
      {
        field: 'status',
        message:
          "Invalid enum value. Expected 'ACTIVE' | 'RESERVED' | 'SOLD_OUT' | 'DRAFT', received 'X'",
      },
    ],
  ],
  [
    'produto: destaque texto',
    adminProductInputSchema,
    { ...product, featured: 'true' },
    [{ field: 'featured', message: 'Expected boolean, received string' }],
  ],
  [
    'produto: slug inválido',
    adminProductInputSchema,
    { ...product, slug: 'Camiseta X' },
    [{ field: 'slug', message: 'Use letras minúsculas, números e hífens.' }],
  ],
  [
    'produto: slug longo demais',
    adminProductInputSchema,
    { ...product, slug: 'a'.repeat(121) },
    [{ field: 'slug', message: 'String must contain at most 120 character(s)' }],
  ],
  [
    'produto: textos vazios',
    adminProductInputSchema,
    { ...product, name: 'a', brand: ' ', description: '', note: '' },
    [
      { field: 'name', message: 'String must contain at least 2 character(s)' },
      { field: 'brand', message: 'String must contain at least 1 character(s)' },
      { field: 'description', message: 'String must contain at least 1 character(s)' },
      { field: 'note', message: 'String must contain at least 1 character(s)' },
    ],
  ],
  [
    'produto: textos longos demais',
    adminProductInputSchema,
    {
      ...product,
      name: 'a'.repeat(161),
      brand: 'a'.repeat(121),
      description: 'a'.repeat(5001),
      note: 'a'.repeat(241),
      categorySlug: 'a'.repeat(41),
    },
    [
      { field: 'name', message: 'String must contain at most 160 character(s)' },
      { field: 'brand', message: 'String must contain at most 120 character(s)' },
      { field: 'description', message: 'String must contain at most 5000 character(s)' },
      { field: 'note', message: 'String must contain at most 240 character(s)' },
      { field: 'categorySlug', message: 'String must contain at most 40 character(s)' },
    ],
  ],
  [
    'edição de produto: corpo vazio',
    adminProductPatchSchema,
    {},
    [{ field: '', message: 'Informe pelo menos um campo para alterar.' }],
  ],
  [
    'edição de produto: só campo desconhecido',
    adminProductPatchSchema,
    { campoDesconhecido: 1 },
    [{ field: '', message: 'Informe pelo menos um campo para alterar.' }],
  ],
  [
    'edição de produto: preço zero',
    adminProductPatchSchema,
    { priceCents: 0 },
    [{ field: 'priceCents', message: 'Number must be greater than 0' }],
  ],
  [
    'edição de produto: status desconhecido',
    adminProductPatchSchema,
    { status: 'X' },
    [
      {
        field: 'status',
        message:
          "Invalid enum value. Expected 'ACTIVE' | 'RESERVED' | 'SOLD_OUT' | 'DRAFT', received 'X'",
      },
    ],
  ],
  [
    'variação: corpo vazio',
    adminVariantInputSchema,
    {},
    [
      { field: 'sku', message: 'Required' },
      { field: 'size', message: 'Required' },
      { field: 'stock', message: 'Required' },
    ],
  ],
  [
    'variação: sku vazio',
    adminVariantInputSchema,
    { ...variant, sku: '' },
    [
      { field: 'sku', message: 'SKU inválido.' },
      { field: 'sku', message: 'String must contain at least 1 character(s)' },
    ],
  ],
  [
    'variação: sku com espaço',
    adminVariantInputSchema,
    { ...variant, sku: 'CAM VA' },
    [{ field: 'sku', message: 'SKU inválido.' }],
  ],
  [
    'variação: sku longo demais',
    adminVariantInputSchema,
    { ...variant, sku: 'A'.repeat(65) },
    [{ field: 'sku', message: 'String must contain at most 64 character(s)' }],
  ],
  [
    'variação: tamanho e cor inválidos',
    adminVariantInputSchema,
    { ...variant, size: '', color: '' },
    [
      { field: 'size', message: 'String must contain at least 1 character(s)' },
      { field: 'color', message: 'String must contain at least 1 character(s)' },
    ],
  ],
  [
    'variação: tamanho e cor longos demais',
    adminVariantInputSchema,
    { ...variant, size: 'a'.repeat(21), color: 'a'.repeat(41) },
    [
      { field: 'size', message: 'String must contain at most 20 character(s)' },
      { field: 'color', message: 'String must contain at most 40 character(s)' },
    ],
  ],
  [
    'variação: estoque negativo',
    adminVariantInputSchema,
    { ...variant, stock: -1 },
    [{ field: 'stock', message: 'Number must be greater than or equal to 0' }],
  ],
  [
    'variação: estoque acima do limite',
    adminVariantInputSchema,
    { ...variant, stock: 100_001 },
    [{ field: 'stock', message: 'Number must be less than or equal to 100000' }],
  ],
  [
    'variação: estoque fracionado',
    adminVariantInputSchema,
    { ...variant, stock: 1.5 },
    [{ field: 'stock', message: 'Expected integer, received float' }],
  ],
  [
    'variação: estoque texto',
    adminVariantInputSchema,
    { ...variant, stock: '3' },
    [{ field: 'stock', message: 'Expected number, received string' }],
  ],
  ['estoque: corpo vazio', adminStockUpdateSchema, {}, [{ field: 'stock', message: 'Required' }]],
  [
    'estoque: negativo e fracionado',
    adminStockUpdateSchema,
    { stock: -1.5 },
    [
      { field: 'stock', message: 'Expected integer, received float' },
      { field: 'stock', message: 'Number must be greater than or equal to 0' },
    ],
  ],
  [
    'pedidos: status desconhecido',
    adminOrderQuerySchema,
    { status: 'paid' },
    [
      {
        field: 'status',
        message:
          "Invalid enum value. Expected 'PENDING_PAYMENT' | 'PAID' | 'CANCELED' | 'EXPIRED' | 'SHIPPED', received 'paid'",
      },
    ],
  ],
  [
    'pedidos: paginação fora da faixa',
    adminOrderQuerySchema,
    { pagina: '0', porPagina: '101' },
    [
      { field: 'pagina', message: 'Number must be greater than or equal to 1' },
      { field: 'porPagina', message: 'Number must be less than or equal to 100' },
    ],
  ],
  [
    'status do pedido: corpo vazio',
    adminOrderStatusUpdateSchema,
    {},
    [{ field: 'status', message: 'Required' }],
  ],
  [
    'status do pedido: desconhecido',
    adminOrderStatusUpdateSchema,
    { status: 'REFUNDED' },
    [
      {
        field: 'status',
        message:
          "Invalid enum value. Expected 'PENDING_PAYMENT' | 'PAID' | 'CANCELED' | 'EXPIRED' | 'SHIPPED', received 'REFUNDED'",
      },
    ],
  ],
];

for (const [name, schema, input, errors] of cases) {
  test(`mensagens: ${name}`, () => {
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.deepEqual(
      result.error?.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      errors,
    );
  });
}
