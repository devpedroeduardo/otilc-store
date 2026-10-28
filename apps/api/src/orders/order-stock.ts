import { InternalServerErrorException, Logger } from '@nestjs/common';
import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { OrderStatus } from '@otilc/shared';
import type { Database } from '../db/client';
import { orderItems, variants } from '../db/schema';
import { lockOrder } from './lock-order';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Efeito de cada transição no estoque da variação (docs/api/admin.md). `guard` é a condição
 * que precisa valer na linha para o ajuste ser coerente; se não valer, o banco está inconsistente.
 */
export type StockEffect = (quantity: number) => {
  set: { stock?: SQL; reserved?: SQL };
  guard?: SQL;
};
export const stockEffects: Partial<Record<`${OrderStatus}>${OrderStatus}`, StockEffect>> = {
  // A unidade é vendida: sai da reserva e do estoque.
  'PENDING_PAYMENT>PAID': (q) => ({
    set: { reserved: sql`${variants.reserved} - ${q}`, stock: sql`${variants.stock} - ${q}` },
    guard: gte(variants.reserved, q),
  }),
  // Volta a ficar disponível.
  'PENDING_PAYMENT>CANCELED': (q) => ({
    set: { reserved: sql`${variants.reserved} - ${q}` },
    guard: gte(variants.reserved, q),
  }),
  // A peça volta ao estoque. O dinheiro não: o estorno é manual, fora da loja.
  'PAID>CANCELED': (q) => ({ set: { stock: sql`${variants.stock} + ${q}` } }),
};

const logger = new Logger('OrderStock');

/**
 * Aplica o efeito no estoque de cada item do pedido. Chamar dentro da transação que já mudou o
 * status do pedido (e, com isso, travou a linha dele): o pedido é travado antes das variações.
 * As variações são travadas na mesma ordem do checkout e do job de expiração (ver `lockOrder`).
 */
export async function applyStockEffect(
  tx: Tx,
  orderId: string,
  effect: StockEffect,
): Promise<void> {
  const rows = await tx
    .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  for (const item of lockOrder(rows)) {
    const { set, guard } = effect(item.quantity);
    const adjusted = await tx
      .update(variants)
      .set(set)
      .where(and(eq(variants.id, item.variantId), guard))
      .returning({ id: variants.id });
    if (adjusted.length === 0) {
      logger.error(`Reserva inconsistente no pedido ${orderId}, variação ${item.variantId}.`);
      throw new InternalServerErrorException('Não foi possível ajustar o estoque do pedido.');
    }
  }
}
