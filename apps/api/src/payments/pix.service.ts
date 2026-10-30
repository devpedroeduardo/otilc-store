import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { OrderStatus, PixChargeDto } from '@otilc/shared';
import { ENV, pixConfig, type Env } from '../config/env';
import { DB, type Database } from '../db/client';
import { orders, payments } from '../db/schema';
import { PIX_PROVIDER, isOrderId, toChargeStatus, type PixProvider } from './mercadopago.client';
import { PaymentTransitionService } from './payment-transition.service';
import { pixError } from './pix-errors';
import { PIX_EXPIRATION_TIME, pixExpiresAt } from './pix-expiration';

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
   * A gravação revalida o pedido com ele travado; se ele deixou de ser pagável enquanto o Mercado
   * Pago criava o Pix, nada é gravado, o Pix é cancelado lá e a resposta é ORDER_NOT_PAYABLE.
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
        customerName: true,
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
        payerFirstName: firstName(order.customerName),
        expirationTime: PIX_EXPIRATION_TIME,
        idempotencyKey: `otilc-pix-${orderId}-${attempts + 1}`,
      });
    } catch (err) {
      this.logger.warn(`Falha ao criar o Pix do pedido ${orderId}: ${(err as Error).message}`);
      throw pixError('PIX_UNAVAILABLE');
    }
    const status = toChargeStatus(remote.status, remote.statusDetail);
    if (!status) {
      this.logger.warn(
        `Pix do pedido ${orderId} criado com status "${remote.status}/${remote.statusDetail ?? ''}".`,
      );
      throw pixError('PIX_UNAVAILABLE');
    }

    // Grava com o pedido travado (pedido → cobrança, a ordem do `PaymentTransitionService`) e só se
    // ele ainda pode ser pago: o painel trava o mesmo pedido ao marcar pago ou cancelar (spec-019),
    // então ou a cobrança entra antes e o painel a vê, ou o painel grava antes e ela não entra.
    const saved = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: orders.status, expiresAt: orders.expiresAt })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update');
      if (locked?.status !== 'PENDING_PAYMENT' || locked.expiresAt.getTime() <= Date.now()) {
        return 'not_payable' as const;
      }
      const [row] = await tx
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
      return row;
    });
    if (saved === 'not_payable') {
      // O pedido saiu de PENDING_PAYMENT (ou venceu) durante a criação: o Pix recém-criado no
      // Mercado Pago é cancelado, já sem trava aberta. Falha só vai para o log (o Pix vence sozinho).
      await this.cancelOrphan(orderId, remote.id);
      throw pixError('ORDER_NOT_PAYABLE');
    }
    if (saved) return { charge: toDto(saved, order), created: true };

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
   * Cobrança com id antigo (numérico, de antes da API de Orders) não é consultada: só log.
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
      if (reserved.length > 0 && !isOrderId(payment.providerPaymentId)) {
        this.logger.warn(
          `Verificação do pagamento ${payment.id} pulada: id do provedor não é de order.`,
        );
      } else if (reserved.length > 0) {
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

  /** Cancela no Mercado Pago um Pix que não foi gravado. Ids no log, nunca dados do cliente. */
  private async cancelOrphan(orderId: string, providerPaymentId: string): Promise<void> {
    try {
      const remote = await this.provider?.cancelPayment(providerPaymentId);
      if (remote && remote.status !== 'canceled') {
        this.logger.warn(
          `Pix ${providerPaymentId} do pedido ${orderId} não gravado ficou "${remote.status}" ao cancelar.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Cancelamento do Pix ${providerPaymentId} falhou (pedido ${orderId}, não gravado): ${(err as Error).message}`,
      );
    }
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

/** Primeiro nome do cliente para o Mercado Pago (`payer.first_name`). */
function firstName(customerName: string): string {
  return customerName.trim().split(/\s+/)[0] ?? '';
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
