import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/client';
import { orders, paymentAlert, paymentNotifications, payments } from '../db/schema';
import { applyStockEffect, stockEffects } from '../orders/order-stock';
import {
  PIX_PROVIDER,
  PixProviderError,
  toChargeStatus,
  type PixProvider,
} from './mercadopago.client';

export type SyncOutcome =
  | 'duplicate'
  | 'unknown_payment'
  | 'unknown_status'
  | 'updated'
  | 'paid'
  | 'already_approved'
  | 'paid_after_expiry'
  | 'amount_mismatch'
  | 'duplicate_payment';

/** Pagamento aprovado que não pagou o pedido ganha um alerta; o estorno é manual. */
const alertFor: Partial<Record<SyncOutcome, (typeof paymentAlert.enumValues)[number]>> = {
  amount_mismatch: 'AMOUNT_MISMATCH',
  paid_after_expiry: 'PAID_AFTER_EXPIRY',
  duplicate_payment: 'DUPLICATE_PAYMENT',
};

const sell = stockEffects['PENDING_PAYMENT>PAID']!;

/**
 * A única transição de status por pagamento, usada pelo webhook e pela verificação sob demanda.
 *
 * O status vem sempre da consulta ao Mercado Pago, feita fora da transação; o corpo do webhook
 * nunca é usado. Dentro da transação, trava o pedido, depois a cobrança, depois as variações
 * (`applyStockEffect`): a mesma ordem do job de expiração e do painel, sem deadlock com eles.
 * A mudança para PAID é condicional (`WHERE status = 'PENDING_PAYMENT'`) e acontece uma vez só.
 */
@Injectable()
export class PaymentTransitionService {
  private readonly logger = new Logger(PaymentTransitionService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PIX_PROVIDER) private readonly provider: PixProvider | null,
  ) {}

  /**
   * Sincroniza a cobrança `providerPaymentId` com o Mercado Pago. Com `requestId` (webhook), o
   * registro da notificação entra na mesma transação: se algo falhar, nada fica gravado e o
   * reenvio é processado normalmente; se o `requestId` já existir, nada é reprocessado.
   */
  async sync(providerPaymentId: string, requestId?: string): Promise<SyncOutcome> {
    const local = await this.db.query.payments.findFirst({
      where: eq(payments.providerPaymentId, providerPaymentId),
      columns: { id: true, orderId: true },
    });
    if (!local) {
      // Pagamento que não é da loja, ou notificação que chegou antes de a cobrança ser gravada.
      // Nada é registrado: o reenvio do mesmo `x-request-id` ainda pode ser processado.
      this.logger.warn(`Notificação de pagamento desconhecido ${providerPaymentId}; ignorada.`);
      return 'unknown_payment';
    }
    if (!this.provider) throw new PixProviderError('Pix desligado.');
    const remote = await this.provider.getPayment(providerPaymentId);

    return this.db.transaction(async (tx) => {
      if (requestId && !(await this.recordNotification(tx, requestId, providerPaymentId))) {
        return 'duplicate';
      }

      const [order] = await tx
        .select({
          id: orders.id,
          status: orders.status,
          totalCents: orders.totalCents,
          expiresAt: orders.expiresAt,
        })
        .from(orders)
        .where(eq(orders.id, local.orderId))
        .for('update');
      const [payment] = await tx
        .select({ id: payments.id, status: payments.status })
        .from(payments)
        .where(eq(payments.id, local.id))
        .for('update');

      const status = toChargeStatus(remote.status);
      if (!status) {
        this.logger.warn(
          `Status "${remote.status}" desconhecido no pagamento ${providerPaymentId}; nada mudou.`,
        );
        return 'unknown_status';
      }

      if (status !== 'APPROVED') {
        // Nunca volta para PENDING: isso poderia colidir com uma tentativa nova do mesmo pedido.
        if (status !== payment.status && status !== 'PENDING') {
          await tx
            .update(payments)
            .set({ status, updatedAt: new Date() })
            .where(eq(payments.id, payment.id));
        }
        return 'updated';
      }
      if (payment.status === 'APPROVED') return 'already_approved';

      const approvedAt = remote.dateApproved ?? new Date();
      const matches =
        remote.externalReference === order.id &&
        remote.amountCents === order.totalCents &&
        remote.currency === 'BRL';

      let outcome: SyncOutcome;
      if (!matches) {
        outcome = 'amount_mismatch';
      } else if (order.status === 'PENDING_PAYMENT' && approvedAt <= order.expiresAt) {
        // Pago dentro do prazo: a reserva ainda está de pé, mesmo que o webhook chegue depois.
        const changed = await tx
          .update(orders)
          .set({ status: 'PAID' })
          .where(and(eq(orders.id, order.id), eq(orders.status, 'PENDING_PAYMENT')))
          .returning({ id: orders.id });
        if (changed.length > 0) await applyStockEffect(tx, order.id, sell);
        outcome = 'paid';
      } else if (order.status === 'PAID' || order.status === 'SHIPPED') {
        // Pago por outro caminho (ex.: painel): a cobrança não paga o pedido de novo.
        outcome = 'duplicate_payment';
      } else {
        outcome = 'paid_after_expiry';
      }

      const alert = alertFor[outcome] ?? null;
      if (alert) {
        this.logger.warn(`Pagamento ${providerPaymentId} do pedido ${order.id}: alerta ${alert}.`);
      }
      await tx
        .update(payments)
        .set({ status: 'APPROVED', approvedAt, alert, updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      return outcome;
    });
  }

  /** Grava o `x-request-id`. `false` se ele já existia (notificação repetida). */
  private async recordNotification(
    db: Pick<Database, 'insert'>,
    requestId: string,
    providerPaymentId: string,
  ): Promise<boolean> {
    const inserted = await db
      .insert(paymentNotifications)
      .values({ requestId, providerPaymentId })
      .onConflictDoNothing()
      .returning({ id: paymentNotifications.id });
    return inserted.length > 0;
  }
}
