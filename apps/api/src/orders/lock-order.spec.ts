import { lockOrder } from './lock-order';

describe('lockOrder', () => {
  it('junta variações repetidas somando as quantidades', () => {
    expect(
      lockOrder([
        { variantId: 'a', quantity: 1 },
        { variantId: 'b', quantity: 2 },
        { variantId: 'a', quantity: 3 },
      ]),
    ).toEqual([
      { variantId: 'a', quantity: 4 },
      { variantId: 'b', quantity: 2 },
    ]);
  });

  it('ordena por variantId', () => {
    const rows = [
      { variantId: 'f3c1d2e0-0000-4000-8000-000000000000', quantity: 1 },
      { variantId: '0a9b8c7d-0000-4000-8000-000000000000', quantity: 1 },
      { variantId: '7e6d5c4b-0000-4000-8000-000000000000', quantity: 1 },
    ];
    expect(lockOrder(rows).map((r) => r.variantId)).toEqual([
      '0a9b8c7d-0000-4000-8000-000000000000',
      '7e6d5c4b-0000-4000-8000-000000000000',
      'f3c1d2e0-0000-4000-8000-000000000000',
    ]);
  });

  it('não altera a entrada', () => {
    const rows = [
      { variantId: 'b', quantity: 1 },
      { variantId: 'a', quantity: 2 },
      { variantId: 'b', quantity: 3 },
    ];
    const copy = structuredClone(rows);
    lockOrder(rows);
    expect(rows).toEqual(copy);
  });

  it('lista vazia devolve lista vazia', () => {
    expect(lockOrder([])).toEqual([]);
  });
});
