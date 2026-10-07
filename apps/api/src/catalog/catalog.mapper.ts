import type { ProductDetailDto, ProductListItemDto } from '@otilc/shared';

interface Row {
  slug: string;
  name: string;
  brand: string | null;
  description: string | null;
  note: string | null;
  priceCents: number;
  condition: string | null;
  status: ProductListItemDto['status'];
  featured: boolean;
  category: { slug: string; name: string };
  images: { url: string; alt: string; position: number }[];
  variants: {
    id: string;
    sku: string;
    size: string;
    color: string | null;
    stock: number;
    reserved: number;
  }[];
}

/** O Postgres devolve NUMERIC como texto; a API entrega número. */
const toCondition = (value: string | null): number | null =>
  value === null ? null : Number(value);

const available = (v: { stock: number; reserved: number }) => Math.max(0, v.stock - v.reserved);

export function toListItem(row: Row): ProductListItemDto {
  const image = [...row.images].sort((a, b) => a.position - b.position)[0];
  return {
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    priceCents: row.priceCents,
    condition: toCondition(row.condition),
    status: effectiveStatus(row),
    featured: row.featured,
    category: row.category,
    image: image ? { url: image.url, alt: image.alt } : null,
    sizes: row.variants.filter((v) => available(v) > 0).map((v) => v.size),
  };
}

export function toDetail(row: Row): ProductDetailDto {
  return {
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    description: row.description,
    note: row.note,
    priceCents: row.priceCents,
    condition: toCondition(row.condition),
    status: effectiveStatus(row),
    featured: row.featured,
    category: row.category,
    images: [...row.images]
      .sort((a, b) => a.position - b.position)
      .map(({ url, alt }) => ({ url, alt })),
    variants: row.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      size: v.size,
      color: v.color,
      available: available(v),
    })),
  };
}

/**
 * Status mostrado na loja. Um produto ativo sem nenhuma unidade livre aparece como
 * reservado (há pedido aguardando pagamento) ou esgotado.
 */
export function effectiveStatus(
  row: Pick<Row, 'status' | 'variants'>,
): ProductListItemDto['status'] {
  if (row.status !== 'ACTIVE') return row.status;
  if (row.variants.some((v) => available(v) > 0)) return 'ACTIVE';
  return row.variants.some((v) => v.reserved > 0) ? 'RESERVED' : 'SOLD_OUT';
}
