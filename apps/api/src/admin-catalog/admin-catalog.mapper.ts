import type { AdminProductDto, AdminVariantDto } from '@otilc/shared';

export interface AdminProductRow {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  description: string | null;
  note: string | null;
  priceCents: number;
  condition: string | null;
  status: AdminProductDto['status'];
  featured: boolean;
  createdAt: Date;
  updatedAt: Date;
  category: { slug: string; name: string };
  images: { url: string; alt: string; position: number }[];
  variants: AdminVariantDto[];
}

/**
 * Produto como o painel vê: status gravado (sem o "reservado/esgotado" calculado da vitrine),
 * estoque e reservado de cada variação.
 */
export function toAdminProduct(row: AdminProductRow): AdminProductDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    description: row.description,
    note: row.note,
    priceCents: row.priceCents,
    // O Postgres devolve NUMERIC como texto; a API entrega número.
    condition: row.condition === null ? null : Number(row.condition),
    status: row.status,
    featured: row.featured,
    category: { slug: row.category.slug, name: row.category.name },
    images: [...row.images]
      .sort((a, b) => a.position - b.position)
      .map(({ url, alt }) => ({ url, alt })),
    variants: row.variants.map(toAdminVariant),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAdminVariant(v: AdminVariantDto): AdminVariantDto {
  return {
    id: v.id,
    sku: v.sku,
    size: v.size,
    color: v.color,
    stock: v.stock,
    reserved: v.reserved,
  };
}
