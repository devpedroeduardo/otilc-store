import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { ENV, type Env } from '../config/env';
import { DB, type Database } from '../db/client';
import { payments } from '../db/schema';
import { PIX_PROVIDER, type PixProvider } from './mercadopago.client';
import { PaymentTransitionService } from './payment-transition.service';
import { skipIfRunning } from './skip-if-running';
import { ON_DEMAND_CHECK_SECONDS } from './pix.service';

/** Máximo de pagamentos conferidos com o Mercado Pago por rodada. */
export const RECONCILIATION_BATCH = 50;

export interface ReconciliationResult {
  /** Pagamentos reivindicados e consultados no Mercado Pago nesta rodada. */
  checked: number;
  /** Consultas ou transições que falharam (ficam para a próxima rodada). */
  failed: number;
}

/**
 * Resultado do cancelamento do Pix pendente de um pedido:
 * - `no_charge`: o pedido não tem Pix PENDING; nada foi chamado;
 * - `pix_disabled`: tem Pix PENDING, mas o Pix está desligado neste ambiente;
 * - `cancelled`: a cobrança foi encerrada (CANCELLED, ou REJECTED/REFUNDED pela resposta);
 * - `approved`: o Mercado Pago respondeu que o Pix já foi pago; o `syncFrom` aplicou a aprovação;
 * - `failed`: o PUT ou a transição falhou, ou a cobrança continua PENDING (vai para o log).
 */
export type CancelChargeResult = 'no_charge' | 'pix_disabled' | 'cancelled' | 'approved' | 'failed';

/** Colunas da cobrança que o cancelamento usa. */
const chargeColumns = {
  id: payments.id,
  orderId: payments.orderId,
  providerPaymentId: payments.providerPaymentId,
};

/**
 * Conciliação periódica do Pix (spec-015): confere com o Mercado Pago os pagamentos que o webhook
 * e a verificação sob demanda podem ter perdido, e cancela no Mercado Pago o Pix de pedido expirado
 * ou que o painel vai marcar como pago ou cancelado (spec-019).
 *
 * Nenhuma chamada ao Mercado Pago acontece com transação ou trava aberta: a reivindicação é um
 * único UPDATE (com `FOR UPDATE SKIP LOCKED` e `last_checked_at = now()`) que termina antes das
 * consultas, e a transição é sempre a do `PaymentTransitionService.sync()`.
 */
@Injectable()
export class PaymentReconciliationService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(PIX_PROVIDER) private readonly provider: PixProvider | null,
    @Inject(PaymentTransitionService) private readonly transition: PaymentTransitionService,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test' || !this.provider) return;
    // Uma rodada lenta (Mercado Pago devagar) não se sobrepõe à seguinte nesta instância.
    const tick = skipIfRunning(
      () => this.reconcile(),
      (err) => this.logger.error(err),
    );
    this.timer = setInterval(() => void tick(), this.env.PAYMENT_RECONCILIATION_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Uma rodada. Seleciona até 50 pagamentos, os nunca conferidos primeiro:
   * - PENDING criados há mais de 2 min (o webhook chega antes) e há menos de 24 h;
   * - APPROVED nos últimos 7 dias e não conferidos há 6 h (estorno ou contestação);
   * - nunca um conferido há menos de 20 s (verificação sob demanda ou outra instância).
   */
  async reconcile(): Promise<ReconciliationResult> {
    if (!this.provider) return { checked: 0, failed: 0 };

    const due = this.db
      .select({ id: payments.id, previous: payments.lastCheckedAt })
      .from(payments)
      .where(
        and(
          or(
            and(
              eq(payments.status, 'PENDING'),
              lt(payments.createdAt, sql`now() - interval '2 minutes'`),
              gt(payments.createdAt, sql`now() - interval '24 hours'`),
            ),
            and(
              eq(payments.status, 'APPROVED'),
              // Redundante (o Pix vale 31 min, então foi criado no máximo 31 min antes de ser
              // aprovado), mas deixa o índice (status, created_at) cortar o histórico antigo.
              gt(payments.createdAt, sql`now() - interval '8 days'`),
              gt(payments.approvedAt, sql`now() - interval '7 days'`),
              or(
                isNull(payments.lastCheckedAt),
                lt(payments.lastCheckedAt, sql`now() - interval '6 hours'`),
              ),
            ),
          ),
          or(
            isNull(payments.lastCheckedAt),
            lt(
              payments.lastCheckedAt,
              sql`now() - make_interval(secs => ${ON_DEMAND_CHECK_SECONDS})`,
            ),
          ),
        ),
      )
      .orderBy(sql`${payments.lastCheckedAt} ASC NULLS FIRST`)
      .limit(RECONCILIATION_BATCH)
      .for('update', { skipLocked: true })
      .as('due');

    // Reivindicação num comando só: o UPDATE termina (e solta as travas) antes das consultas.
    // Outra instância pula as linhas travadas e, depois do commit, as descarta pelo filtro de 20 s.
    const claimed = await this.db
      .update(payments)
      .set({ lastCheckedAt: sql`now()` })
      .from(due)
      .where(eq(payments.id, due.id))
      .returning({
        id: payments.id,
        providerPaymentId: payments.providerPaymentId,
        previous: due.previous,
        claimedAt: payments.lastCheckedAt,
      });

    let failed = 0;
    for (const { id, providerPaymentId, previous, claimedAt } of claimed) {
      try {
        await this.transition.sync(providerPaymentId);
      } catch (err) {
        failed++;
        this.logger.warn(
          `Conciliação do pagamento ${providerPaymentId} falhou: ${(err as Error).message}`,
        );
        await this.release(id, previous, claimedAt);
      }
    }
    if (claimed.length > 0) {
      this.logger.log(
        `Conciliação: ${claimed.length} pagamento(s) conferido(s), ${failed} com falha.`,
      );
    }
    return { checked: claimed.length, failed };
  }

  /**
   * Devolve o `last_checked_at` de antes da reivindicação, para a rodada seguinte tentar de novo
   * (um APPROVED esperaria 6 h). Só se ninguém conferiu o pagamento depois: o banco guarda
   * microssegundos e o `Date` só milissegundos, por isso o limite é `claimedAt + 1 ms`.
   */
  private async release(id: string, previous: Date | null, claimedAt: Date | null): Promise<void> {
    if (!claimedAt) return;
    try {
      await this.db
        .update(payments)
        .set({ lastCheckedAt: previous })
        .where(
          and(eq(payments.id, id), lt(payments.lastCheckedAt, new Date(claimedAt.getTime() + 1))),
        );
    } catch (err) {
      this.logger.error(err);
    }
  }

  /**
   * Cancela no Mercado Pago o Pix pendente dos pedidos que acabaram de expirar. Chamado depois do
   * commit da expiração. Falha só vai para o log: a conciliação confere o pagamento depois.
   * Se o Mercado Pago responder que o Pix já foi pago, o `sync` aplica PAID_AFTER_EXPIRY.
   */
  async cancelForExpiredOrders(orderIds: string[]): Promise<void> {
    if (!this.provider || orderIds.length === 0) return;
    const pending = await this.db
      .select(chargeColumns)
      .from(payments)
      .where(and(inArray(payments.orderId, orderIds), eq(payments.status, 'PENDING')));

    for (const charge of pending) await this.cancelCharge(this.provider, charge);
  }

  /**
   * Cancela no Mercado Pago o Pix pendente de um pedido, antes de o painel marcá-lo como pago ou
   * cancelado (spec-019). Roda fora de qualquer transação; quem chama decide o que fazer com o
   * resultado. Sem `provider` e com Pix pendente no banco, devolve `pix_disabled` (o painel recusa).
   */
  async cancelPendingCharge(orderId: string): Promise<CancelChargeResult> {
    const [charge] = await this.db
      .select(chargeColumns)
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'PENDING')));
    if (!charge) return 'no_charge';
    if (!this.provider) return 'pix_disabled';
    return this.cancelCharge(this.provider, charge);
  }

  /**
   * PUT de cancelamento e transição pela resposta (`syncFrom`). O resultado vem do status local
   * depois da transição: só uma cobrança encerrada garante que o QR não é mais pagável.
   * Falha vai para o log com os ids do pagamento e do pedido, nunca com dados do cliente.
   */
  private async cancelCharge(
    provider: PixProvider,
    charge: { id: string; orderId: string; providerPaymentId: string },
  ): Promise<CancelChargeResult> {
    const { providerPaymentId, orderId } = charge;
    try {
      const remote = await provider.cancelPayment(providerPaymentId);
      await this.transition.syncFrom(remote);
    } catch (err) {
      this.logger.warn(
        `Cancelamento do Pix ${providerPaymentId} falhou (pedido ${orderId}): ${(err as Error).message}`,
      );
      return 'failed';
    }
    const after = await this.db.query.payments.findFirst({
      where: eq(payments.id, charge.id),
      columns: { status: true },
    });
    if (after?.status === 'APPROVED') return 'approved';
    if (!after || after.status === 'PENDING') {
      // Resposta que não encerra a cobrança (ex.: status desconhecido): o QR pode continuar vivo.
      this.logger.warn(
        `Cancelamento do Pix ${providerPaymentId} falhou (pedido ${orderId}): a cobrança continua pendente.`,
      );
      return 'failed';
    }
    return 'cancelled';
  }
}
