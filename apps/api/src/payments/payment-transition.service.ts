import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/client';
import { orders, paymentAlert, paymentAlerts, paymentNotifications, payments } from '../db/schema';
import { applyStockEffect, stockEffects } from '../orders/order-stock';
import {
  PIX_PROVIDER,
  PixProviderError,
  toChargeStatus,
  type PixProvider,
  type ProviderPayment,
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
  | 'duplicate_payment'
  | 'payment_reversed';

type PaymentAlert = (typeof paymentAlert.enumValues)[number];

/** Status do Mercado Pago que desfazem um pagamento já aprovado (estorno ou contestação). */
const REVERSED_STATUSES = new Set(['refunded', 'charged_back', 'in_mediation']);

/**
 * Pagamento aprovado que não pagou o pedido ganha um alerta; o estorno é manual. Os alertas se
 * acumulam em `payment_alerts` (um de cada tipo por pagamento) e nenhum apaga ou substitui outro.
 */
const alertFor: Partial<Record<SyncOutcome, PaymentAlert>> = {
  amount_mismatch: 'AMOUNT_MISMATCH',
  paid_after_expiry: 'PAID_AFTER_EXPIRY',
  duplicate_payment: 'DUPLICATE_PAYMENT',
};

const sell = stockEffects['PENDING_PAYMENT>PAID']!;

/**
 * A única transição de status por pagamento, usada pelo webhook, pela verificação sob demanda,
 * pela conciliação periódica e pelo cancelamento do Pix de pedido expirado.
 *
 * O status vem sempre da consulta ao Mercado Pago, feita fora da transação; o corpo do webhook
 * nunca é usado. Dentro da transação, trava o pedido, depois a cobrança, depois as variações
 * (`applyStockEffect`): a mesma ordem do job de expiração e do painel, sem deadlock com eles.
 * A mudança para PAID é condicional (`WHERE status = 'PENDING_PAYMENT'`) e acontece uma vez só.
 * Repetir a mesma consulta não grava nem registra no log nada de novo.
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
    const local = await this.findLocal(providerPaymentId);
    if (!local) return 'unknown_payment';
    if (!this.provider) throw new PixProviderError('Pix desligado.');
    const remote = await this.provider.getPayment(providerPaymentId);
    return this.apply(local, remote, requestId);
  }

  /**
   * Como `sync`, mas com o pagamento que o Mercado Pago já devolveu (ex.: resposta do
   * cancelamento), sem consultar de novo. Também roda fora de qualquer transação do chamador.
   */
  async syncFrom(remote: ProviderPayment): Promise<SyncOutcome> {
    const local = await this.findLocal(remote.id);
    if (!local) return 'unknown_payment';
    return this.apply(local, remote);
  }

  private async findLocal(providerPaymentId: string) {
    const local = await this.db.query.payments.findFirst({
      where: eq(payments.providerPaymentId, providerPaymentId),
      columns: { id: true, orderId: true },
    });
    if (!local) {
      // Pagamento que não é da loja, ou notificação que chegou antes de a cobrança ser gravada.
      // Nada é registrado: o reenvio do mesmo `x-request-id` ainda pode ser processado.
      this.logger.warn(`Notificação de pagamento desconhecido ${providerPaymentId}; ignorada.`);
    }
    return local;
  }

  private apply(
    local: { id: string; orderId: string },
    remote: ProviderPayment,
    requestId?: string,
  ): Promise<SyncOutcome> {
    const providerPaymentId = remote.id;
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

      if (payment.status === 'APPROVED' && REVERSED_STATUSES.has(remote.status)) {
        // Estornado ou contestado depois de pago: só alerta, o pedido não muda (estorno manual).
        // Um alerta anterior (ex.: PAID_AFTER_EXPIRY) continua gravado ao lado deste.
        if (remote.status === 'refunded') {
          await tx
            .update(payments)
            .set({ status: 'REFUNDED', updatedAt: new Date() })
            .where(eq(payments.id, payment.id));
        }
        await this.recordAlert(tx, {
          paymentId: payment.id,
          providerPaymentId,
          orderId: order.id,
          alert: 'PAYMENT_REVERSED',
        });
        return 'payment_reversed';
      }

      const status = toChargeStatus(remote.status);
      if (!status) {
        this.logger.warn(
          `Status "${remote.status}" desconhecido no pagamento ${providerPaymentId}; nada mudou.`,
        );
        return 'unknown_status';
      }

      if (status !== 'APPROVED') {
        // Só uma cobrança PENDING encerra por aqui. Nunca volta para PENDING (colidiria com uma
        // tentativa nova do mesmo pedido), e APPROVED ou REFUNDED não regridem com uma resposta
        // atrasada (ex.: `cancelled` do PUT); APPROVED só vira REFUNDED pelo estorno, acima.
        if (payment.status !== 'PENDING' || status === 'PENDING') return 'updated';
        if (status === 'REFUNDED') {
          // Aprovado e estornado entre duas consultas: o pedido nunca foi pago, sem alerta.
          this.logger.warn(
            `Pagamento ${providerPaymentId} do pedido ${order.id} estornado antes de ser visto aprovado.`,
          );
        }
        await tx
          .update(payments)
          .set({ status, updatedAt: new Date() })
          .where(eq(payments.id, payment.id));
        return 'updated';
      }
      if (payment.status === 'APPROVED') return 'already_approved';

      const approvedAt = this.approvedAt(remote);
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

      await tx
        .update(payments)
        .set({ status: 'APPROVED', approvedAt, updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      const alert = alertFor[outcome];
      if (alert) {
        await this.recordAlert(tx, {
          paymentId: payment.id,
          providerPaymentId,
          orderId: order.id,
          alert,
        });
      }
      return outcome;
    });
  }

  /**
   * Momento da aprovação: `date_approved`; sem ele, `date_last_updated`; sem os dois, agora. Os
   * dois últimos ficam no log, porque decidem se o pagamento entrou no prazo do pedido.
   */
  private approvedAt(remote: ProviderPayment): Date {
    if (remote.dateApproved) return remote.dateApproved;
    if (remote.dateLastUpdated) {
      this.logger.warn(
        `Pagamento ${remote.id} aprovado sem date_approved; usado date_last_updated.`,
      );
      return remote.dateLastUpdated;
    }
    this.logger.warn(
      `Pagamento ${remote.id} aprovado sem date_approved nem date_last_updated; usada a hora atual.`,
    );
    return new Date();
  }

  /**
   * Acrescenta o alerta ao histórico, uma vez por tipo (`UNIQUE (payment_id, alert)`), e o deixa em
   * `payments.alert` só se ela ainda estiver vazia. Alerta novo vai para o log: ids e tipo, nunca
   * dados do cliente. Repetido, não grava nem registra nada.
   */
  private async recordAlert(
    tx: Pick<Database, 'insert' | 'update'>,
    a: { paymentId: string; providerPaymentId: string; orderId: string; alert: PaymentAlert },
  ): Promise<void> {
    const inserted = await tx
      .insert(paymentAlerts)
      .values({ paymentId: a.paymentId, alert: a.alert })
      .onConflictDoNothing()
      .returning({ id: paymentAlerts.id });
    if (inserted.length === 0) return;
    await tx
      .update(payments)
      .set({ alert: sql`COALESCE(${payments.alert}, ${a.alert})` })
      .where(eq(payments.id, a.paymentId));
    this.logger.warn(`Pagamento ${a.providerPaymentId} do pedido ${a.orderId}: alerta ${a.alert}.`);
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
