import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { OrderStatus, PixChargeDto } from '@otilc/shared';
import { ENV, pixConfig, type Env } from '../config/env';
import { DB, type Database } from '../db/client';
import { orders, payments } from '../db/schema';
import { PIX_PROVIDER, toChargeStatus, type PixProvider } from './mercadopago.client';
import { PaymentTransitionService } from './payment-transition.service';
import { pixError } from './pix-errors';
import { pixExpiresAt } from './pix-expiration';

/** Intervalo mínimo entre duas consultas sob demanda ao Mercado Pago para o mesmo pedido. */
export const ON_DEMAND_CHECK_SECONDS = 20;

type PaymentRow = typeof payments.$inferSelect;

@Injectable()
export class PixService {
  private readonly logger = new Logger(PixService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(PIX_PROVIDER) private readonly provider: PixProvider | null,
    @Inject(PaymentTransitionService) private readonly transition: PaymentTransitionService,
  ) {}

  /**
   * Cria a cobrança Pix do pedido, ou devolve a PENDING que já existe (sem chamar o provedor).
   * O valor é sempre o total do pedido no banco. Duas chamadas simultâneas usam a mesma chave de
   * idempotência (pedido + tentativa), recebem o mesmo pagamento do Mercado Pago e só uma grava:
   * o UNIQUE de `provider_payment_id` e o índice de uma PENDING por pedido barram a outra.
   */
  async createCharge(orderId: string): Promise<{ charge: PixChargeDto; created: boolean }> {
    const config = pixConfig(this.env);
    if (!config || !this.provider) throw pixError('PIX_UNAVAILABLE');

    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: {
        id: true,
        number: true,
        status: true,
        totalCents: true,
        expiresAt: true,
        customerEmail: true,
      },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    if (order.status !== 'PENDING_PAYMENT' || order.expiresAt.getTime() <= Date.now()) {
      throw pixError('ORDER_NOT_PAYABLE');
    }

    const pending = await this.findPending(orderId);
    if (pending) return { charge: toDto(pending, order), created: false };

    const [{ attempts }] = await this.db
      .select({ attempts: count() })
      .from(payments)
      .where(eq(payments.orderId, orderId));
    const expiresAt = pixExpiresAt(new Date());

    let remote;
    try {
      remote = await this.provider.createPixPayment({
        orderId,
        orderNumber: order.number,
        amountCents: order.totalCents,
        payerEmail: order.customerEmail,
        expiresAt,
        notificationUrl: config.notificationUrl,
        idempotencyKey: `otilc-pix-${orderId}-${attempts + 1}`,
      });
    } catch (err) {
      this.logger.warn(`Falha ao criar o Pix do pedido ${orderId}: ${(err as Error).message}`);
      throw pixError('PIX_UNAVAILABLE');
    }
    const status = toChargeStatus(remote.status);
    if (!status) {
      this.logger.warn(`Pix do pedido ${orderId} criado com status "${remote.status}".`);
      throw pixError('PIX_UNAVAILABLE');
    }

    const [inserted] = await this.db
      .insert(payments)
      .values({
        orderId,
        providerPaymentId: remote.id,
        status,
        amountCents: order.totalCents,
        qrCode: remote.qrCode,
        qrCodeBase64: remote.qrCodeBase64,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { charge: toDto(inserted, order), created: true };

    // Outra chamada simultânea gravou primeiro.
    const existing =
      (await this.findPending(orderId)) ??
      (await this.db.query.payments.findFirst({
        where: and(eq(payments.providerPaymentId, remote.id), eq(payments.orderId, orderId)),
      }));
    if (!existing) {
      this.logger.warn(
        `Cobrança do pedido ${orderId} não gravada (conflito sem cobrança visível).`,
      );
      throw pixError('PIX_UNAVAILABLE');
    }
    return { charge: await this.withOrder(existing), created: false };
  }

  /**
   * Cobrança mais recente do pedido. Se ela está PENDING e o pedido PENDING_PAYMENT, consulta o
   * Mercado Pago no máximo uma vez a cada 20 s por pedido: a reserva da vez é um UPDATE atômico
   * de `last_checked_at`, e só quem recebeu a linha consulta. Falha do provedor não vira erro.
   */
  async getCharge(orderId: string): Promise<PixChargeDto> {
    let payment = await this.latest(orderId);
    if (!payment) throw new NotFoundException('Cobrança Pix não encontrada.');
    let charge = await this.withOrder(payment);

    if (this.provider && charge.status === 'PENDING' && charge.orderStatus === 'PENDING_PAYMENT') {
      const reserved = await this.db
        .update(payments)
        .set({ lastCheckedAt: sql`now()` })
        .where(
          and(
            eq(payments.id, payment.id),
            eq(payments.status, 'PENDING'),
            sql`(${payments.lastCheckedAt} IS NULL OR ${payments.lastCheckedAt} < now() - make_interval(secs => ${ON_DEMAND_CHECK_SECONDS}))`,
          ),
        )
        .returning({ id: payments.id });
      if (reserved.length > 0) {
        try {
          await this.transition.sync(payment.providerPaymentId);
        } catch (err) {
          this.logger.warn(
            `Verificação do Pix do pedido ${orderId} falhou: ${(err as Error).message}`,
          );
        }
        payment = (await this.latest(orderId)) ?? payment;
        charge = await this.withOrder(payment);
      }
    }
    return charge;
  }

  private findPending(orderId: string) {
    return this.db.query.payments.findFirst({
      where: and(eq(payments.orderId, orderId), eq(payments.status, 'PENDING')),
    });
  }

  private latest(orderId: string) {
    return this.db.query.payments.findFirst({
      where: eq(payments.orderId, orderId),
      orderBy: [desc(payments.createdAt)],
    });
  }

  private async withOrder(payment: PaymentRow): Promise<PixChargeDto> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, payment.orderId),
      columns: { status: true, expiresAt: true },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    return toDto(payment, order);
  }
}

function toDto(payment: PaymentRow, order: { status: OrderStatus; expiresAt: Date }): PixChargeDto {
  return {
    orderId: payment.orderId,
    orderStatus: order.status,
    status: payment.status,
    amountCents: payment.amountCents,
    qrCode: payment.qrCode ?? '',
    qrCodeBase64: payment.qrCodeBase64 ?? '',
    // Prazo para pagar é o do pedido (contrato); a validade no provedor fica em payments.expires_at.
    expiresAt: order.expiresAt.toISOString(),
  };
}
