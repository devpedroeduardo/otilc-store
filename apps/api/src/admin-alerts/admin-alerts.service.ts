import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, gte, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { AdminAlertDto, AdminAlertQuery, Paginated } from '@otilc/shared';
import { DB, type Database } from '../db/client';
import { adminUsers, orders, paymentAlerts, payments } from '../db/schema';
import { RECONCILIATION_MAX_FAILURES } from '../payments/reconciliation-backoff';
import { alertConflict } from './admin-alerts.errors';

const situationFilter: Record<AdminAlertQuery['situacao'], SQL | undefined> = {
  abertos: isNull(paymentAlerts.resolvedAt),
  resolvidos: isNotNull(paymentAlerts.resolvedAt),
  todos: undefined,
};

@Injectable()
export class AdminAlertsService {
  private readonly logger = new Logger(AdminAlertsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /** Alertas do mais novo para o mais antigo, com o pagamento e o pedido de cada um. */
  async list(query: AdminAlertQuery): Promise<Paginated<AdminAlertDto>> {
    const where = and(
      situationFilter[query.situacao],
      query.tipo ? eq(paymentAlerts.alert, query.tipo) : undefined,
    );
    const offset = (query.pagina - 1) * query.porPagina;
    const [rows, [{ total }]] = await Promise.all([
      this.select()
        .where(where)
        // O id desempata alertas do mesmo instante (gravados na mesma transação).
        .orderBy(desc(paymentAlerts.createdAt), desc(paymentAlerts.id))
        .limit(query.porPagina)
        .offset(offset),
      this.db.select({ total: count() }).from(paymentAlerts).where(where),
    ]);

    return {
      items: rows.map(toDto),
      page: query.pagina,
      perPage: query.porPagina,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.porPagina)),
    };
  }

  /**
   * Marca o alerta como resolvido por `adminId`. O UPDATE só pega alerta aberto: de dois resolves
   * simultâneos, o segundo espera a trava da linha, relê `resolved_at` já preenchido e recebe 409.
   */
  async resolve(id: string, adminId: string): Promise<AdminAlertDto> {
    const [row] = await this.db
      .update(paymentAlerts)
      .set({ resolvedAt: new Date(), resolvedBy: adminId })
      .where(and(eq(paymentAlerts.id, id), isNull(paymentAlerts.resolvedAt)))
      .returning({ id: paymentAlerts.id });
    if (!row) {
      await this.findAlert(id);
      throw alertConflict('ALERT_ALREADY_RESOLVED');
    }
    return this.findById(id);
  }

  /**
   * Retoma a conciliação de um pagamento que bateu no teto de falhas (spec-020): zera
   * `check_failures` e `next_check_at`, e mais nada. Não consulta o Mercado Pago, não muda status
   * de pagamento, pedido ou estoque e não resolve o alerta. O UPDATE só pega pagamento ainda no
   * teto: se uma resposta do Mercado Pago (ou outro admin) já zerou o contador, a resposta é 409.
   * No teto a conciliação não reivindica o pagamento, então não há consulta em andamento.
   */
  async resumeReconciliation(id: string, adminId: string): Promise<AdminAlertDto> {
    const alert = await this.findAlert(id);
    if (alert.type !== 'RECONCILIATION_STOPPED') throw alertConflict('ALERT_NOT_RESUMABLE');
    const [payment] = await this.db
      .update(payments)
      .set({ checkFailures: 0, nextCheckAt: null })
      .where(
        and(
          eq(payments.id, alert.paymentId),
          gte(payments.checkFailures, RECONCILIATION_MAX_FAILURES),
        ),
      )
      .returning({ providerPaymentId: payments.providerPaymentId });
    if (!payment) throw alertConflict('RECONCILIATION_NOT_STOPPED');
    this.logger.log(
      `Conciliação do pagamento ${payment.providerPaymentId} retomada pelo admin ${adminId}.`,
    );
    return this.findById(id);
  }

  private async findAlert(id: string): Promise<{ type: string; paymentId: string }> {
    const [alert] = await this.db
      .select({ type: paymentAlerts.alert, paymentId: paymentAlerts.paymentId })
      .from(paymentAlerts)
      .where(eq(paymentAlerts.id, id));
    if (!alert) throw new NotFoundException('Alerta não encontrado.');
    return alert;
  }

  private async findById(id: string): Promise<AdminAlertDto> {
    const [row] = await this.select().where(eq(paymentAlerts.id, id));
    if (!row) throw new NotFoundException('Alerta não encontrado.');
    return toDto(row);
  }

  private select() {
    return this.db
      .select({
        id: paymentAlerts.id,
        type: paymentAlerts.alert,
        createdAt: paymentAlerts.createdAt,
        resolvedAt: paymentAlerts.resolvedAt,
        resolverName: adminUsers.name,
        resolverEmail: adminUsers.email,
        payment: {
          id: payments.id,
          providerPaymentId: payments.providerPaymentId,
          status: payments.status,
          amountCents: payments.amountCents,
        },
        order: { id: orders.id, number: orders.number, status: orders.status },
      })
      .from(paymentAlerts)
      .innerJoin(payments, eq(payments.id, paymentAlerts.paymentId))
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .leftJoin(adminUsers, eq(adminUsers.id, paymentAlerts.resolvedBy))
      .$dynamic();
  }
}

type AlertRow = Awaited<ReturnType<ReturnType<AdminAlertsService['select']>['execute']>>[number];

function toDto(r: AlertRow): AdminAlertDto {
  return {
    id: r.id,
    type: r.type,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    // Admin removido: o nome some (ON DELETE SET NULL), a data da resolução fica.
    resolvedBy: r.resolverName || r.resolverEmail || null,
    payment: r.payment,
    order: r.order,
  };
}
