import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import {
  canTransitionOrder,
  type AdminOrderDetailDto,
  type AdminOrderListItemDto,
  type AdminOrderQuery,
  type OrderStatus,
  type Paginated,
} from '@otilc/shared';
import { DB, type Database } from '../db/client';
import { orderItems, orders, payments, variants } from '../db/schema';
import { applyStockEffect, stockEffects, type Tx } from '../orders/order-stock';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service';

/** Mensagens do PATCH de status quando o Pix pendente não pode ser cancelado (spec-019). */
export const pixCancelMessages = {
  approved: 'Este pedido já foi pago pelo Pix.',
  failed: 'Não foi possível cancelar o Pix no Mercado Pago. Tente de novo.',
  pixDisabled:
    'Este pedido tem um Pix pendente, mas o Pix está desligado neste ambiente: não é possível cancelá-lo no Mercado Pago.',
  newCharge:
    'Um novo Pix foi gerado para este pedido durante a operação. Recarregue e tente de novo.',
};

@Injectable()
export class AdminOrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PaymentReconciliationService) private readonly payments: PaymentReconciliationService,
  ) {}

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
   * As variações são travadas na mesma ordem do checkout e do job (ver `lockOrder`).
   *
   * Saindo de PENDING_PAYMENT (pagar ou cancelar), o Pix pendente é cancelado no Mercado Pago
   * antes, fora de qualquer transação (`cancelPix`): o QR antigo deixa de ser pagável e não há
   * cobrança dupla. Se o cancelamento não se confirmar, nada muda no banco.
   */
  async updateStatus(id: string, to: OrderStatus): Promise<AdminOrderDetailDto> {
    const current = await this.db.query.orders.findFirst({
      where: eq(orders.id, id),
      columns: { status: true },
    });
    if (!current) throw new NotFoundException('Pedido não encontrado.');
    // Transição inválida não chega ao Mercado Pago; a transação confere de novo com o estado atual.
    if (current.status === 'PENDING_PAYMENT' && canTransitionOrder(current.status, to)) {
      await this.cancelPix(id);
    }
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
      if (from === 'PENDING_PAYMENT' && (await this.hasPendingPix(tx, id))) {
        // O cliente gerou outro Pix depois do cancelamento. O UPDATE acima trava o pedido, e o
        // `PixService` só grava cobrança com o pedido travado e PENDING_PAYMENT: o que entrou antes
        // aparece aqui; o que viria depois não entra.
        throw new ConflictException(pixCancelMessages.newCharge);
      }

      const effect = stockEffects[`${from}>${to}`];
      // Mesma ordem de trava do checkout e do job de expiração (evita deadlock).
      if (effect) await applyStockEffect(tx, id, effect);

      return this.detail(tx, id);
    });
  }

  /**
   * Cancela o Pix pendente do pedido no Mercado Pago. Sem Pix pendente, segue como antes. Se o
   * Mercado Pago responder que o Pix já foi pago, o `syncFrom` já aplicou o pagamento (o pedido
   * fica PAID pelo Pix, com estoque baixado uma vez) e o painel recebe 409.
   */
  private async cancelPix(id: string): Promise<void> {
    const result = await this.payments.cancelPendingCharge(id);
    switch (result) {
      case 'no_charge':
      case 'cancelled':
        return;
      case 'approved':
        throw new ConflictException(pixCancelMessages.approved);
      case 'pix_disabled':
        throw new ServiceUnavailableException(pixCancelMessages.pixDisabled);
      case 'failed':
        throw new BadGatewayException(pixCancelMessages.failed);
    }
  }

  private async hasPendingPix(tx: Tx, orderId: string): Promise<boolean> {
    const [pending] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'PENDING')))
      .limit(1);
    return pending !== undefined;
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
