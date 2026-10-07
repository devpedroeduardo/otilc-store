import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSchema, mergeCartItems } from './checkout';

const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };

test('junta itens repetidos do carrinho', () => {
  assert.deepEqual(
    mergeCartItems([
      { variantId: 'a', quantity: 1 },
      { variantId: 'b', quantity: 2 },
      { variantId: 'a', quantity: 3 },
    ]),
    [
      { variantId: 'a', quantity: 4 },
      { variantId: 'b', quantity: 2 },
    ],
  );
});

test('descarta campos extras como preço enviado pelo navegador', () => {
  const parsed = checkoutSchema.parse({
    items: [{ variantId: 'a', quantity: 1, priceCents: 1 }],
    customer,
    totalCents: 1,
  });
  assert.deepEqual(parsed.items[0], { variantId: 'a', quantity: 1 });
  assert.equal('totalCents' in parsed, false);
});

test('recusa carrinho vazio e quantidade inválida', () => {
  assert.equal(checkoutSchema.safeParse({ items: [], customer }).success, false);
  assert.equal(
    checkoutSchema.safeParse({ items: [{ variantId: 'a', quantity: 0 }], customer }).success,
    false,
  );
});
