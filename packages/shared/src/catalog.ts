import { z } from 'zod';

/** Condição de peças seminovas, de 0 a 10 (aceita uma casa decimal, ex.: 7,5). Peças novas não têm condição (null). */
export const conditionSchema = z.number().min(0).max(10).multipleOf(0.1).nullable();

export const productStatusSchema = z.enum(['ACTIVE', 'RESERVED', 'SOLD_OUT', 'DRAFT']);
export type ProductStatus = z.infer<typeof productStatusSchema>;

export const catalogSortSchema = z.enum(['destaque', 'menor-preco', 'maior-preco', 'novidades']);
export type CatalogSort = z.infer<typeof catalogSortSchema>;

/** Filtros aceitos pela listagem do catálogo (query string). */
export const catalogQuerySchema = z.object({
  categoria: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Categoria inválida.')
    .max(40)
    .optional(),
  ordem: catalogSortSchema.default('destaque'),
  pagina: z.coerce.number().int().min(1).max(500).default(1),
  porPagina: z.coerce.number().int().min(1).max(48).default(24),
});
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

export interface CategoryDto {
  slug: string;
  name: string;
}

export interface VariantDto {
  id: string;
  sku: string;
  size: string;
  color: string | null;
  /** Quantidade que ainda pode ser vendida (estoque menos reservas). */
  available: number;
}

export interface ProductImageDto {
  url: string;
  alt: string;
}

export interface ProductListItemDto {
  slug: string;
  name: string;
  brand: string | null;
  priceCents: number;
  condition: number | null;
  status: ProductStatus;
  featured: boolean;
  category: CategoryDto;
  image: ProductImageDto | null;
  sizes: string[];
}

export interface ProductDetailDto extends Omit<ProductListItemDto, 'image' | 'sizes'> {
  description: string | null;
  note: string | null;
  images: ProductImageDto[];
  variants: VariantDto[];
}

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}
