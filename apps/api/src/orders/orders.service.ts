import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { CheckoutInput, OrderDto } from '@otilc/shared';
import { ENV, type Env } from '../config/env';
import { DB, type Database } from '../db/client';
import { orderItems, orders, products, variants } from '../db/schema';
import { lockOrder } from './lock-order';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Cria o pedido e reserva o estoque na mesma transação.
   *
   * A reserva usa um UPDATE condicional (`stock - reserved >= quantidade`). O Postgres trava a
   * linha da variação durante o UPDATE, então duas compras simultâneas da última unidade não
   * passam as duas: a segunda encontra a condição falsa e o pedido é recusado com 409.
   * O preço vem sempre do banco, nunca do navegador.
   */
  async create(input: CheckoutInput): Promise<OrderDto> {
    // Mesma ordem de trava do painel e do job de expiração (evita deadlock).
    const items = lockOrder(input.items);

    return this.db.transaction(async (tx) => {
      const found = await tx
        .select({
          variantId: variants.id,
          size: variants.size,
          productName: products.name,
          priceCents: products.priceCents,
          productStatus: products.status,
        })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(
          inArray(
            variants.id,
            items.map((i) => i.variantId),
          ),
        );
      const byId = new Map(found.map((f) => [f.variantId, f]));

      for (const item of items) {
        const v = byId.get(item.variantId);
        if (!v || v.productStatus !== 'ACTIVE') {
          throw new UnprocessableEntityException(
            'Um dos produtos do carrinho não está mais disponível.',
          );
        }
      }

      for (const item of items) {
        const reserved = await tx
          .update(variants)
          .set({ reserved: sql`${variants.reserved} + ${item.quantity}` })
          .where(
            and(
              eq(variants.id, item.variantId),
              sql`${variants.stock} - ${variants.reserved} >= ${item.quantity}`,
            ),
          )
          .returning({ id: variants.id });

        if (reserved.length === 0) {
          const v = byId.get(item.variantId)!;
          throw new ConflictException(`Estoque insuficiente para ${v.productName} (${v.size}).`);
        }
      }

      const lines = items.map((item) => {
        const v = byId.get(item.variantId)!;
        return {
          variantId: item.variantId,
          productName: v.productName,
          size: v.size,
          unitPriceCents: v.priceCents,
          quantity: item.quantity,
        };
      });
      const totalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
      const expiresAt = new Date(Date.now() + this.env.ORDER_HOLD_MINUTES * 60_000);

      const [order] = await tx
        .insert(orders)
        .values({
          customerName: input.customer.name,
          customerEmail: input.customer.email.toLowerCase(),
          customerPhone: input.customer.phone,
          totalCents,
          expiresAt,
        })
        .returning();

      await tx.insert(orderItems).values(lines.map((l) => ({ ...l, orderId: order.id })));

      return {
        id: order.id,
        number: order.number,
        status: order.status,
        totalCents,
        expiresAt: expiresAt.toISOString(),
        items: lines,
      };
    });
  }

  async findById(id: string): Promise<OrderDto> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, id),
      with: { items: true },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      totalCents: order.totalCents,
      expiresAt: order.expiresAt.toISOString(),
      items: order.items.map(({ variantId, productName, size, unitPriceCents, quantity }) => ({
        variantId,
        productName,
        size,
        unitPriceCents,
        quantity,
      })),
    };
  }

  /**
   * Libera o estoque de pedidos que passaram do prazo sem pagamento.
   * `FOR UPDATE SKIP LOCKED` deixa várias instâncias da API rodarem isso ao mesmo tempo
   * sem processar o mesmo pedido duas vezes. Trava os pedidos antes das variações, como o painel.
   */
  async releaseExpired(now = new Date()): Promise<number> {
    return this.db.transaction(async (tx) => {
      const expired = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.status, 'PENDING_PAYMENT'), lt(orders.expiresAt, now)))
        .for('update', { skipLocked: true });
      if (expired.length === 0) return 0;

      const ids = expired.map((o) => o.id);
      const rows = await tx
        .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids));

      // Itens de todos os pedidos da rodada somados por variação: cada variação é atualizada uma
      // vez só, na mesma ordem do checkout e do painel (os itens voltam do banco em qualquer ordem).
      for (const item of lockOrder(rows)) {
        await tx
          .update(variants)
          .set({ reserved: sql`GREATEST(${variants.reserved} - ${item.quantity}, 0)` })
          .where(eq(variants.id, item.variantId));
      }
      await tx.update(orders).set({ status: 'EXPIRED' }).where(inArray(orders.id, ids));

      this.logger.log(`${ids.length} pedido(s) expirado(s); estoque liberado.`);
      return ids.length;
    });
  }
}
