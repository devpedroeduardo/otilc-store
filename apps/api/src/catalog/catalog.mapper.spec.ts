import { effectiveStatus, toListItem } from './catalog.mapper';

const variant = (stock: number, reserved: number, size = 'M') => ({
  id: size,
  sku: `SKU-${size}`,
  size,
  color: null,
  stock,
  reserved,
});

describe('effectiveStatus', () => {
  it('mantém ativo quando há unidade livre', () => {
    expect(effectiveStatus({ status: 'ACTIVE', variants: [variant(2, 1)] })).toBe('ACTIVE');
  });

  it('mostra reservado quando todo o estoque está preso em pedidos', () => {
    expect(effectiveStatus({ status: 'ACTIVE', variants: [variant(1, 1)] })).toBe('RESERVED');
  });

  it('mostra esgotado quando não há estoque', () => {
    expect(effectiveStatus({ status: 'ACTIVE', variants: [variant(0, 0)] })).toBe('SOLD_OUT');
  });

  it('respeita o status definido manualmente', () => {
    expect(effectiveStatus({ status: 'SOLD_OUT', variants: [variant(3, 0)] })).toBe('SOLD_OUT');
  });
});

describe('toListItem', () => {
  it('converte a condição e lista só os tamanhos disponíveis', () => {
    const item = toListItem({
      slug: 'x',
      name: 'Camiseta',
      brand: null,
      description: null,
      note: null,
      priceCents: 5000,
      condition: '7.5',
      status: 'ACTIVE',
      featured: false,
      category: { slug: 'camisetas', name: 'Camisetas' },
      images: [
        { url: '/b.webp', alt: 'b', position: 1 },
        { url: '/a.webp', alt: 'a', position: 0 },
      ],
      variants: [variant(1, 0, 'M'), variant(1, 1, 'G')],
    });
    expect(item.condition).toBe(7.5);
    expect(item.sizes).toEqual(['M']);
    expect(item.image).toEqual({ url: '/a.webp', alt: 'a' });
  });
});
