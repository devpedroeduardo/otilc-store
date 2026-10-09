import { toAdminProduct, type AdminProductRow } from './admin-catalog.mapper';
import { uniqueViolation } from './db-errors';

const row: AdminProductRow = {
  id: 'p1',
  slug: 'camiseta-veja-alem',
  name: 'Camiseta Veja Além',
  brand: 'OTILC',
  description: null,
  note: null,
  priceCents: 12990,
  condition: '9.5',
  status: 'ACTIVE',
  featured: true,
  createdAt: new Date('2026-10-08T12:00:00.000Z'),
  updatedAt: new Date('2026-10-08T13:00:00.000Z'),
  category: { slug: 'camisetas', name: 'Camisetas' },
  images: [
    { url: 'https://img/2.jpg', alt: 'costas', position: 1 },
    { url: 'https://img/1.jpg', alt: 'frente', position: 0 },
  ],
  variants: [{ id: 'v1', sku: 'CAM-P', size: 'P', color: null, stock: 0, reserved: 0 }],
};

describe('toAdminProduct', () => {
  it('converte condição, datas e ordena as imagens', () => {
    const dto = toAdminProduct(row);
    expect(dto.condition).toBe(9.5);
    expect(dto.createdAt).toBe('2026-10-08T12:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-10-08T13:00:00.000Z');
    expect(dto.images).toEqual([
      { url: 'https://img/1.jpg', alt: 'frente' },
      { url: 'https://img/2.jpg', alt: 'costas' },
    ]);
  });

  it('mantém o status gravado, mesmo sem unidade livre (a vitrine é que calcula SOLD_OUT)', () => {
    expect(toAdminProduct(row).status).toBe('ACTIVE');
    expect(toAdminProduct({ ...row, condition: null }).condition).toBeNull();
  });
});

describe('uniqueViolation', () => {
  it('acha a restrição no erro do pg embrulhado pela Drizzle', () => {
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'variants_sku_unique',
    });
    const wrapped = Object.assign(new Error('Failed query'), { cause: pgError });
    expect(uniqueViolation(wrapped)).toBe('variants_sku_unique');
    expect(uniqueViolation(pgError)).toBe('variants_sku_unique');
  });

  it('devolve null para outros erros', () => {
    expect(uniqueViolation(new Error('x'))).toBeNull();
    expect(uniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBeNull();
    expect(uniqueViolation(undefined)).toBeNull();
  });
});
