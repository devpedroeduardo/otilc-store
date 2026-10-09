import { eq } from 'drizzle-orm';
import { createDatabase } from '../../apps/api/src/db/client';
import { orders, products, variants } from '../../apps/api/src/db/schema';
import { assertE2EDatabaseUrl, E2E_DATABASE_URL } from './env';

/** Leitura direta do banco de teste para conferir o efeito das ações feitas pela tela. */
export async function withDb<T>(fn: (db: ReturnType<typeof createDatabase>['db']) => Promise<T>) {
  assertE2EDatabaseUrl(E2E_DATABASE_URL);
  const { db, pool } = createDatabase(E2E_DATABASE_URL);
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

export interface VariantState {
  id: string;
  productId: string;
  stock: number;
  reserved: number;
}

/** Variação única de um produto do seed (cada peça do Drop 00 tem uma variação). */
export function variantOf(slug: string): Promise<VariantState> {
  return withDb(async (db) => {
    const [row] = await db
      .select({
        id: variants.id,
        productId: variants.productId,
        stock: variants.stock,
        reserved: variants.reserved,
      })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(products.slug, slug));
    if (!row) throw new Error(`Produto ${slug} não encontrado no seed.`);
    return row;
  });
}

export function orderStatus(number: number): Promise<string | undefined> {
  return withDb(async (db) => {
    const [row] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.number, number));
    return row?.status;
  });
}
