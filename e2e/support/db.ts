import { eq } from 'drizzle-orm';
import { createDatabase } from '../../apps/api/src/db/client';
import { orders, paymentAlerts, payments, products, variants } from '../../apps/api/src/db/schema';
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

/** Pagamento Pix pendente com um alerta aberto, semeado direto no banco (a API não os cria sozinha). */
export function seedAlert(
  orderId: string,
  alert: typeof paymentAlerts.$inferInsert.alert,
  amountCents: number,
): Promise<void> {
  return withDb(async (db) => {
    const [payment] = await db
      .insert(payments)
      .values({
        orderId,
        providerPaymentId: `e2e-${crypto.randomUUID()}`,
        status: 'PENDING',
        amountCents,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: payments.id });
    await db.insert(paymentAlerts).values({ paymentId: payment!.id, alert });
  });
}

export function alertResolved(orderId: string): Promise<boolean> {
  return withDb(async (db) => {
    const [row] = await db
      .select({ resolvedAt: paymentAlerts.resolvedAt })
      .from(paymentAlerts)
      .innerJoin(payments, eq(payments.id, paymentAlerts.paymentId))
      .where(eq(payments.orderId, orderId));
    return row?.resolvedAt != null;
  });
}
