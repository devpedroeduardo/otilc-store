import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import {
  canTransitionOrder,
  mergeCartItems,
  type AdminOrderDetailDto,
  type AdminOrderListItemDto,
  type AdminOrderQuery,
  type OrderStatus,
  type Paginated,
} from '@otilc/shared';
import { DB, type Database } from '../db/client';
import { orderItems, orders, variants } from '../db/schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Efeito de cada transição no estoque da variação (docs/api/admin.md). `guard` é a condição
 * que precisa valer na linha para o ajuste ser coerente; se não valer, o banco está inconsistente.
 */
type StockEffect = (quantity: number) => {
  set: { stock?: SQL; reserved?: SQL };
  guard?: SQL;
};
const stockEffects: Partial<Record<`${OrderStatus}>${OrderStatus}`, StockEffect>> = {
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

@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /** Pedidos do mais novo para o mais antigo, com filtro opcional de status. */
  async list(query: AdminOrderQuery): Promise<Paginated<AdminOrderListItemDto>> {
    const where = query.status ? eq(orders.status, query.status) : undefined;
    const offset = (query.pagina - 1) * query.porPagina;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: orders.id,
          number: orders.number,
          status: orders.status,
          customerName: orders.customerName,
          totalCents: orders.totalCents,
          // Texto fixo: num select de uma tabela só a Drizzle não qualifica as colunas, e o
          // "id" ficaria ambíguo dentro da subconsulta.
          itemCount: sql<number>`(
            SELECT coalesce(sum(oi.quantity), 0)::int FROM order_items oi WHERE oi.order_id = orders.id
          )`,
          expiresAt: orders.expiresAt,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt), desc(orders.number))
        .limit(query.porPagina)
        .offset(offset),
      this.db.select({ total: count() }).from(orders).where(where),
    ]);

    return {
      items: rows.map((r) => ({
        ...r,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      page: query.pagina,
      perPage: query.porPagina,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.porPagina)),
    };
  }

  findById(id: string): Promise<AdminOrderDetailDto> {
    return this.detail(this.db, id);
  }

  /**
   * Muda o status e ajusta o estoque na mesma transação.
   *
   * O UPDATE do pedido repete o status lido (`WHERE status = <de>`): se o job de expiração ou
   * outro admin mudou o pedido no meio, nenhuma linha muda e a resposta é 409. Esse UPDATE também
   * trava a linha do pedido até o fim da transação. Para pagar, o prazo tem de estar valendo
   * (`expires_at > now()`), mesmo que o job ainda não tenha marcado o pedido como EXPIRED.
   * As variações são travadas na mesma ordem do checkout (ver `OrdersService.create`).
   */
  async updateStatus(id: string, to: OrderStatus): Promise<AdminOrderDetailDto> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query.orders.findFirst({
        where: eq(orders.id, id),
        columns: { status: true },
      });
      if (!current) throw new NotFoundException('Pedido não encontrado.');
      const from = current.status;
      if (!canTransitionOrder(from, to)) {
        throw new ConflictException(`Transição de status inválida: ${from} → ${to}.`);
      }

      const paying = from === 'PENDING_PAYMENT' && to === 'PAID';
      const changed = await tx
        .update(orders)
        .set({ status: to })
        .where(
          and(
            eq(orders.id, id),
            eq(orders.status, from),
            paying ? sql`${orders.expiresAt} > now()` : undefined,
          ),
        )
        .returning({ id: orders.id });
      if (changed.length === 0) {
        throw new ConflictException(await this.conflictReason(tx, id, from, paying));
      }

      const effect = stockEffects[`${from}>${to}`];
      if (effect) {
        const rows = await tx
          .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
          .from(orderItems)
          .where(eq(orderItems.orderId, id));
        // Mesmo merge e mesma chave de ordenação do checkout: todas as transações travam as
        // variações na mesma ordem, o que evita deadlock entre painel e loja.
        const items = mergeCartItems(rows).sort((a, b) => a.variantId.localeCompare(b.variantId));
        for (const item of items) {
          const { set, guard } = effect(item.quantity);
          const adjusted = await tx
            .update(variants)
            .set(set)
            .where(and(eq(variants.id, item.variantId), guard))
            .returning({ id: variants.id });
          if (adjusted.length === 0) {
            this.logger.error(`Reserva inconsistente no pedido ${id}, variação ${item.variantId}.`);
            throw new InternalServerErrorException('Não foi possível ajustar o estoque do pedido.');
          }
        }
      }

      return this.detail(tx, id);
    });
  }

  /** Por que o UPDATE condicional não pegou a linha (lido depois, já com o estado atual). */
  private async conflictReason(
    tx: Tx,
    id: string,
    from: OrderStatus,
    paying: boolean,
  ): Promise<string> {
    const now = await tx.query.orders.findFirst({
      where: eq(orders.id, id),
      columns: { status: true },
    });
    if (paying && now?.status === from) {
      return 'O prazo de pagamento deste pedido já terminou; ele não pode ser marcado como pago.';
    }
    return `O pedido mudou de status durante a operação (agora ${now?.status ?? 'removido'}). Recarregue e tente de novo.`;
  }

  private async detail(db: Database | Tx, id: string): Promise<AdminOrderDetailDto> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    const items = await db
      .select({
        variantId: orderItems.variantId,
        sku: variants.sku,
        productName: orderItems.productName,
        size: orderItems.size,
        unitPriceCents: orderItems.unitPriceCents,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .innerJoin(variants, eq(variants.id, orderItems.variantId))
      .where(eq(orderItems.orderId, id))
      .orderBy(asc(orderItems.id));

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      totalCents: order.totalCents,
      expiresAt: order.expiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(),
      items,
    };
  }
}
