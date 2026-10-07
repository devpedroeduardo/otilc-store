import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type {
  CatalogQuery,
  CategoryDto,
  Paginated,
  ProductDetailDto,
  ProductListItemDto,
} from '@otilc/shared';
import { DB, type Database } from '../db/client';
import { categories, products } from '../db/schema';
import { toDetail, toListItem } from './catalog.mapper';

const withRelations = {
  category: { columns: { slug: true, name: true } },
  images: { columns: { url: true, alt: true, position: true } },
  variants: {
    columns: { id: true, sku: true, size: true, color: true, stock: true, reserved: true },
    orderBy: (v: any, { asc: a }: { asc: typeof asc }) => [a(v.size)],
  },
} as const;

@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async listCategories(): Promise<CategoryDto[]> {
    return this.db
      .select({ slug: categories.slug, name: categories.name })
      .from(categories)
      .orderBy(asc(categories.position));
  }

  async list(query: CatalogQuery): Promise<Paginated<ProductListItemDto>> {
    const filters: SQL[] = [ne(products.status, 'DRAFT')];
    if (query.categoria) {
      filters.push(
        inArray(
          products.categoryId,
          this.db
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.slug, query.categoria)),
        ),
      );
    }
    const where = and(...filters);

    // Peças que ainda podem ser compradas vêm primeiro; reservadas e esgotadas vão para o fim,
    // como prova de que as peças saem (mesma regra da vitrine da pré-venda).
    const hasStock = sql`(${products.status} = 'ACTIVE' AND EXISTS (
      SELECT 1 FROM variants v WHERE v.product_id = ${products.id} AND v.stock - v.reserved > 0
    ))`;
    const order: SQL[] = [desc(hasStock)];
    switch (query.ordem) {
      case 'menor-preco':
        order.push(asc(products.priceCents));
        break;
      case 'maior-preco':
        order.push(desc(products.priceCents));
        break;
      case 'novidades':
        order.push(desc(products.createdAt));
        break;
      default:
        order.push(desc(products.featured), desc(products.createdAt));
    }
    order.push(asc(products.id));

    const offset = (query.pagina - 1) * query.porPagina;
    const [ids, [{ total }]] = await Promise.all([
      this.db
        .select({ id: products.id })
        .from(products)
        .where(where)
        .orderBy(...order)
        .limit(query.porPagina)
        .offset(offset),
      this.db.select({ total: count() }).from(products).where(where),
    ]);

    const rows = ids.length
      ? await this.db.query.products.findMany({
          where: inArray(
            products.id,
            ids.map((r) => r.id),
          ),
          with: withRelations,
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));

    return {
      items: ids.map((r) => toListItem(byId.get(r.id)!)),
      page: query.pagina,
      perPage: query.porPagina,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.porPagina)),
    };
  }

  async findBySlug(slug: string): Promise<ProductDetailDto> {
    const row = await this.db.query.products.findFirst({
      where: and(eq(products.slug, slug), ne(products.status, 'DRAFT')),
      with: withRelations,
    });
    if (!row) throw new NotFoundException('Produto não encontrado.');
    return toDetail(row);
  }
}
