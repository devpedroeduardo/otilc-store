import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { ENV, emailConfig, type Env } from '../config/env';
import { DB, type Database } from '../db/client';
import { emailOutbox, orderItems, orders } from '../db/schema';
import type { Tx } from '../orders/order-stock';
import { reconciliationDelayMs } from '../payments/reconciliation-backoff';
import { skipIfRunning } from '../payments/skip-if-running';
import { EMAIL_SENDER, EmailSendError, type EmailSender } from './email-sender';
import { renderOrderConfirmation } from './order-confirmation.template';

/** Tentativas de envio de um e-mail antes de a linha virar `failed`. */
export const EMAIL_MAX_ATTEMPTS = 5;

/** Linhas reivindicadas por rodada. */
export const EMAIL_OUTBOX_BATCH = 20;

/**
 * Prazo de uma reivindicação. Se a instância cair no meio do envio, a linha volta a ser
 * reivindicável depois disso; a `Idempotency-Key` cobre o envio repetido no Resend (24 h).
 */
export const EMAIL_CLAIM_LEASE_SECONDS = 5 * 60;

const ORDER_CONFIRMATION = 'order_confirmation';

export interface EmailOutboxResult {
  sent: number;
  retried: number;
  failed: number;
}

interface ClaimedEmail {
  id: string;
  orderId: string;
  attempts: number;
}

/**
 * Outbox do e-mail de confirmação (spec-036).
 *
 * `enqueueOrderConfirmation` grava a linha na transação de quem muda o pedido para PAID. Depois
 * do commit, quem chamou dá `kick()`, e o e-mail sai em segundos, sem a resposta esperar o
 * provedor. A cada `EMAIL_OUTBOX_INTERVAL_MS`, uma rodada pega o que ficou para trás.
 *
 * Nenhum envio acontece com transação ou trava aberta. A reivindicação é um único UPDATE (com
 * `FOR UPDATE SKIP LOCKED`) que soma a tentativa e empurra `next_attempt_at` para depois do
 * prazo da reivindicação; outra instância não pega a mesma linha. Nada aqui muda pedido nem
 * pagamento. No log vão só id do pedido, tipo, status, tentativa e id do provedor.
 */
@Injectable()
export class EmailOutboxService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EmailOutboxService.name);
  private timer?: NodeJS.Timeout;
  private tick?: () => Promise<void>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
  ) {}

  onModuleInit(): void {
    // Em teste, os e2e chamam `run()` direto e o `kick()` não faz nada.
    if (this.env.NODE_ENV === 'test') return;
    this.tick = skipIfRunning(
      () => this.run(),
      (err) => this.logger.error(err),
    );
    this.timer = setInterval(() => void this.tick?.(), this.env.EMAIL_OUTBOX_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.tick = undefined;
  }

  /**
   * Grava o e-mail de confirmação na transação `tx`, que acabou de mudar o pedido para PAID. Se a
   * transação desfizer, a linha some junto. Repetido, não grava nada (`UNIQUE (order_id, kind)`).
   */
  async enqueueOrderConfirmation(tx: Tx, orderId: string): Promise<void> {
    await tx
      .insert(emailOutbox)
      .values({ orderId, kind: ORDER_CONFIRMATION })
      .onConflictDoNothing();
  }

  /**
   * Gatilho não bloqueante, chamado depois do commit. Se uma rodada já estiver em andamento nesta
   * instância, o gatilho é descartado e a linha sai na próxima rodada do intervalo.
   */
  kick(): void {
    const tick = this.tick;
    if (!tick) return;
    setImmediate(() => void tick());
  }

  /** Uma rodada: reivindica as linhas vencidas e tenta enviar cada uma uma vez. */
  async run(): Promise<EmailOutboxResult> {
    const due = this.db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.nextAttemptAt, sql`now()`)))
      .orderBy(asc(emailOutbox.nextAttemptAt))
      .limit(EMAIL_OUTBOX_BATCH)
      .for('update', { skipLocked: true })
      .as('due');
    const claimed: ClaimedEmail[] = await this.db
      .update(emailOutbox)
      .set({
        attempts: sql`${emailOutbox.attempts} + 1`,
        nextAttemptAt: sql`now() + make_interval(secs => ${EMAIL_CLAIM_LEASE_SECONDS})`,
      })
      .from(due)
      .where(eq(emailOutbox.id, due.id))
      .returning({
        id: emailOutbox.id,
        orderId: emailOutbox.orderId,
        attempts: emailOutbox.attempts,
      });

    const result: EmailOutboxResult = { sent: 0, retried: 0, failed: 0 };
    for (const email of claimed) {
      result[await this.deliver(email)]++;
    }
    return result;
  }

  private async deliver(email: ClaimedEmail): Promise<keyof EmailOutboxResult> {
    try {
      const message = await this.compose(email.orderId);
      const { providerMessageId } = await this.sender.send(message);
      await this.finish(email, {
        status: 'sent',
        sentAt: new Date(),
        providerMessageId,
        lastError: null,
      });
      this.logger.log(
        `E-mail ${ORDER_CONFIRMATION} do pedido ${email.orderId}: sent (tentativa ${email.attempts}, id ${providerMessageId}).`,
      );
      return 'sent';
    } catch (err) {
      const temporary = !(err instanceof EmailSendError) || err.temporary;
      const reason =
        err instanceof EmailSendError ? err.message : 'Erro interno ao montar ou enviar.';
      if (!(err instanceof EmailSendError)) this.logger.error(err);
      const retry = temporary && email.attempts < EMAIL_MAX_ATTEMPTS;
      const delayMs = retry
        ? reconciliationDelayMs(email.attempts, this.env.EMAIL_OUTBOX_INTERVAL_MS)
        : 0;
      await this.finish(
        email,
        retry
          ? { lastError: reason, nextAttemptAt: new Date(Date.now() + delayMs) }
          : { status: 'failed', lastError: reason },
      );
      const status = retry ? 'pending' : 'failed';
      this.logger.warn(
        `E-mail ${ORDER_CONFIRMATION} do pedido ${email.orderId}: ${status} (tentativa ${email.attempts}): ${reason}`,
      );
      return retry ? 'retried' : 'failed';
    }
  }

  /**
   * Grava o resultado só se a linha ainda for desta reivindicação: pendente e com o mesmo número de
   * tentativas. Se o prazo venceu e outra rodada a pegou, quem vale é a outra.
   */
  private async finish(
    email: ClaimedEmail,
    set: Partial<typeof emailOutbox.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(emailOutbox)
      .set(set)
      .where(
        and(
          eq(emailOutbox.id, email.id),
          eq(emailOutbox.status, 'pending'),
          eq(emailOutbox.attempts, email.attempts),
        ),
      );
  }

  private async compose(orderId: string) {
    const [order] = await this.db
      .select({
        number: orders.number,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        totalCents: orders.totalCents,
      })
      .from(orders)
      .where(eq(orders.id, orderId));
    const items = await this.db
      .select({
        productName: orderItems.productName,
        size: orderItems.size,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id));
    const { replyTo } = emailConfig(this.env);
    const rendered = renderOrderConfirmation({
      number: order.number,
      customerName: order.customerName,
      totalCents: order.totalCents,
      items,
      storeUrl: this.env.WEB_ORIGIN,
      contact: replyTo,
    });
    return {
      ref: orderId,
      to: order.customerEmail,
      replyTo,
      idempotencyKey: `order-confirmation/${orderId}`,
      ...rendered,
    };
  }
}
