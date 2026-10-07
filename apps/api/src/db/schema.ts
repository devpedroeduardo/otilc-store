import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const productStatus = pgEnum('product_status', ['ACTIVE', 'RESERVED', 'SOLD_OUT', 'DRAFT']);

export const orderStatus = pgEnum('order_status', [
  'PENDING_PAYMENT',
  'PAID',
  'CANCELED',
  'EXPIRED',
  'SHIPPED',
]);

export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 80 }).notNull(),
  position: integer('position').notNull().default(0),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 120 }).notNull().unique(),
    name: varchar('name', { length: 160 }).notNull(),
    brand: varchar('brand', { length: 120 }),
    description: text('description'),
    note: varchar('note', { length: 240 }),
    // Dinheiro sempre em centavos (inteiro).
    priceCents: integer('price_cents').notNull(),
    // Condição de peça seminova, de 0,0 a 10,0. Nulo para peça nova.
    condition: numeric('condition', { precision: 3, scale: 1 }),
    status: productStatus('status').notNull().default('ACTIVE'),
    featured: boolean('featured').notNull().default(false),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('products_category_idx').on(t.categoryId),
    check('products_price_positive', sql`${t.priceCents} > 0`),
    check(
      'products_condition_range',
      sql`${t.condition} IS NULL OR ${t.condition} BETWEEN 0 AND 10`,
    ),
  ],
);

/**
 * Cada combinação de tamanho e cor tem o próprio estoque.
 * `reserved` guarda as unidades presas em pedidos que aguardam pagamento.
 * As restrições CHECK garantem no banco que nunca se reserva mais do que existe.
 */
export const variants = pgTable(
  'variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: varchar('sku', { length: 64 }).notNull().unique(),
    size: varchar('size', { length: 20 }).notNull(),
    color: varchar('color', { length: 40 }),
    stock: integer('stock').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
  },
  (t) => [
    index('variants_product_idx').on(t.productId),
    uniqueIndex('variants_product_size_color_idx').on(t.productId, t.size, t.color),
    check('variants_stock_non_negative', sql`${t.stock} >= 0`),
    check('variants_reserved_range', sql`${t.reserved} >= 0 AND ${t.reserved} <= ${t.stock}`),
  ],
);

export const productImages = pgTable(
  'product_images',
  {
    id: serial('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    url: varchar('url', { length: 300 }).notNull(),
    alt: varchar('alt', { length: 200 }).notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('product_images_product_idx').on(t.productId)],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Número curto e sequencial para o cliente e para o atendimento.
    number: serial('number').notNull().unique(),
    status: orderStatus('status').notNull().default('PENDING_PAYMENT'),
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    customerEmail: varchar('customer_email', { length: 160 }).notNull(),
    customerPhone: varchar('customer_phone', { length: 20 }).notNull(),
    totalCents: integer('total_cents').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_status_expires_idx').on(t.status, t.expiresAt),
    check('orders_total_positive', sql`${t.totalCents} > 0`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: serial('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id),
    // Cópia do nome, tamanho e preço no momento da compra: o pedido não muda se o produto mudar.
    productName: varchar('product_name', { length: 160 }).notNull(),
    size: varchar('size', { length: 20 }).notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    check('order_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

export const categoriesRelations = relations(categories, ({ many }) => ({
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  variants: many(variants),
  images: many(productImages),
}));

export const variantsRelations = relations(variants, ({ one }) => ({
  product: one(products, { fields: [variants.productId], references: [products.id] }),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, { fields: [productImages.productId], references: [products.id] }),
}));

export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(variants, { fields: [orderItems.variantId], references: [variants.id] }),
}));
