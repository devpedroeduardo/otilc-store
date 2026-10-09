import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, lte, type SQL } from 'drizzle-orm';
import type {
  AdminProductDto,
  AdminProductInput,
  AdminProductPatch,
  AdminVariantDto,
  AdminVariantInput,
} from '@otilc/shared';
import { DB, type Database } from '../db/client';
import { categories, products, variants } from '../db/schema';
import { toAdminProduct, toAdminVariant } from './admin-catalog.mapper';
import { uniqueViolation } from './db-errors';

const variantColumns = {
  id: variants.id,
  sku: variants.sku,
  size: variants.size,
  color: variants.color,
  stock: variants.stock,
  reserved: variants.reserved,
};

const withRelations = {
  category: { columns: { slug: true, name: true } },
  images: { columns: { url: true, alt: true, position: true } },
  variants: {
    columns: { id: true, sku: true, size: true, color: true, stock: true, reserved: true },
    orderBy: [asc(variants.size), asc(variants.sku)],
  },
} satisfies {
  category: { columns: { slug: true; name: true } };
  images: { columns: { url: true; alt: true; position: true } };
  variants: {
    columns: { id: true; sku: true; size: true; color: true; stock: true; reserved: true };
    orderBy: SQL[];
  };
};

/** Mensagens de 409 por restrição UNIQUE do banco. */
const DUPLICATE_MESSAGES: Record<string, string> = {
  products_slug_unique: 'Já existe um produto com este slug.',
  variants_sku_unique: 'Já existe uma variação com este SKU.',
  variants_product_size_color_idx: 'Este produto já tem uma variação com este tamanho e cor.',
};

type ProductValues = Partial<typeof products.$inferInsert>;

/** Condição vai para uma coluna NUMERIC(3,1), que a Drizzle trata como texto. */
const toNumeric = (condition: number | null): string | null =>
  condition === null ? null : condition.toFixed(1);

@Injectable()
export class AdminCatalogService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Todos os produtos, inclusive rascunhos, do mais novo para o mais antigo. */
  async list(): Promise<AdminProductDto[]> {
    const rows = await this.db.query.products.findMany({
      with: withRelations,
      orderBy: [desc(products.createdAt), desc(products.id)],
    });
    return rows.map(toAdminProduct);
  }

  async findById(id: string): Promise<AdminProductDto> {
    const row = await this.db.query.products.findFirst({
      where: eq(products.id, id),
      with: withRelations,
    });
    if (!row) throw new NotFoundException('Produto não encontrado.');
    return toAdminProduct(row);
  }

  async create(input: AdminProductInput): Promise<AdminProductDto> {
    const categoryId = await this.categoryId(input.categorySlug);
    const [created] = await this.withDuplicateCheck(() =>
      this.db
        .insert(products)
        .values({
          slug: input.slug,
          name: input.name,
          brand: input.brand ?? null,
          description: input.description ?? null,
          note: input.note ?? null,
          priceCents: input.priceCents,
          condition: toNumeric(input.condition),
          status: input.status,
          featured: input.featured,
          categoryId,
        })
        .returning({ id: products.id }),
    );
    return this.findById(created.id);
  }

  /** Edição parcial. O preço novo não altera pedidos antigos: `order_items` guarda uma cópia. */
  async update(id: string, patch: AdminProductPatch): Promise<AdminProductDto> {
    const values = await this.productValues(patch);
    const updated = await this.withDuplicateCheck(() =>
      this.db
        .update(products)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(products.id, id))
        .returning({ id: products.id }),
    );
    if (updated.length === 0) throw new NotFoundException('Produto não encontrado.');
    return this.findById(id);
  }

  async createVariant(productId: string, input: AdminVariantInput): Promise<AdminVariantDto> {
    const product = await this.db.query.products.findFirst({
      where: eq(products.id, productId),
      columns: { id: true },
    });
    if (!product) throw new NotFoundException('Produto não encontrado.');

    const [created] = await this.withDuplicateCheck(() =>
      this.db
        .insert(variants)
        .values({
          productId,
          sku: input.sku,
          size: input.size,
          color: input.color ?? null,
          stock: input.stock,
        })
        .returning(variantColumns),
    );
    return toAdminVariant(created);
  }

  /**
   * Define o estoque total. A condição `reserved <= novo estoque` fica no próprio UPDATE:
   * o Postgres trava a linha, então uma reserva simultânea (checkout) ou espera este UPDATE
   * terminar e reavalia a própria condição, ou termina antes e este UPDATE vê o reservado novo.
   * O CHECK `variants_reserved_range` é a última barreira.
   */
  async updateStock(variantId: string, stock: number): Promise<AdminVariantDto> {
    const [updated] = await this.db
      .update(variants)
      .set({ stock })
      .where(and(eq(variants.id, variantId), lte(variants.reserved, stock)))
      .returning(variantColumns);
    if (updated) return toAdminVariant(updated);

    // Nada mudou: a leitura só serve para escolher entre 404 e 409.
    const current = await this.db.query.variants.findFirst({
      where: eq(variants.id, variantId),
      columns: { reserved: true },
    });
    if (!current) throw new NotFoundException('Variação não encontrada.');
    const units =
      current.reserved === 1
        ? 'da 1 unidade reservada'
        : `das ${current.reserved} unidades reservadas`;
    throw new ConflictException(`O estoque não pode ficar abaixo ${units}.`);
  }

  /** Converte os campos enviados no PATCH em colunas; `categorySlug` inexistente é 422. */
  private async productValues(input: AdminProductPatch): Promise<ProductValues> {
    const values: ProductValues = {};
    if (input.slug !== undefined) values.slug = input.slug;
    if (input.name !== undefined) values.name = input.name;
    if (input.brand !== undefined) values.brand = input.brand;
    if (input.description !== undefined) values.description = input.description;
    if (input.note !== undefined) values.note = input.note;
    if (input.priceCents !== undefined) values.priceCents = input.priceCents;
    if (input.condition !== undefined) values.condition = toNumeric(input.condition);
    if (input.status !== undefined) values.status = input.status;
    if (input.featured !== undefined) values.featured = input.featured;
    if (input.categorySlug !== undefined)
      values.categoryId = await this.categoryId(input.categorySlug);
    return values;
  }

  private async categoryId(slug: string): Promise<number> {
    const category = await this.db.query.categories.findFirst({
      where: eq(categories.slug, slug),
      columns: { id: true },
    });
    if (!category) throw new UnprocessableEntityException('Categoria não encontrada.');
    return category.id;
  }

  /** Traduz violação de UNIQUE (slug, SKU, tamanho/cor) em 409 com mensagem clara. */
  private async withDuplicateCheck<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === null) throw err;
      throw new ConflictException(DUPLICATE_MESSAGES[constraint] ?? 'Registro duplicado.');
    }
  }
}
