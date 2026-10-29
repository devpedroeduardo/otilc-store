import { z } from 'zod';
import { integer } from './zod-compat';
import type { OrderStatus } from './checkout';
import type { PixChargeStatus } from './payments';

// ---------------------------------------------------------------------------
// Painel de alertas de pagamento (spec-018). Contrato em `docs/api/admin.md`.
// ---------------------------------------------------------------------------

/** Espelho do enum `payment_alert` do banco. */
export const paymentAlertTypeSchema = z.enum([
  'PAID_AFTER_EXPIRY',
  'AMOUNT_MISMATCH',
  'DUPLICATE_PAYMENT',
  'PAYMENT_REVERSED',
  'RECONCILIATION_STOPPED',
]);
export type PaymentAlertType = z.infer<typeof paymentAlertTypeSchema>;

export const alertSituationSchema = z.enum(['abertos', 'resolvidos', 'todos']);
export type AlertSituation = z.infer<typeof alertSituationSchema>;

/** Filtros da listagem de alertas (query string). Padrão: abertos, página 1, 20 por página. */
export const adminAlertQuerySchema = z.object({
  situacao: alertSituationSchema.default('abertos'),
  tipo: paymentAlertTypeSchema.optional(),
  pagina: z.coerce.number().check(integer).min(1).max(500).default(1),
  porPagina: z.coerce.number().check(integer).min(1).max(100).default(20),
});
export type AdminAlertQuery = z.infer<typeof adminAlertQuerySchema>;

export interface AdminAlertDto {
  id: string;
  type: PaymentAlertType;
  createdAt: string;
  resolvedAt: string | null;
  /** Nome do admin que resolveu (ou o e-mail, sem nome); `null` se aberto ou admin removido. */
  resolvedBy: string | null;
  payment: {
    id: string;
    providerPaymentId: string;
    status: PixChargeStatus;
    amountCents: number;
  };
  order: {
    id: string;
    number: number;
    status: OrderStatus;
  };
}

// ---------------------------------------------------------------------------
// Orientação ao admin
// ---------------------------------------------------------------------------

export interface AlertGuide {
  title: string;
  /** O que fazer, em uma frase. */
  action: string;
}

export const paymentAlertGuides: Record<PaymentAlertType, AlertGuide> = {
  PAID_AFTER_EXPIRY: {
    title: 'Pago depois do prazo',
    action:
      'Confira se há estoque; se houver, siga com o pedido; se não, estorne no painel do Mercado Pago.',
  },
  DUPLICATE_PAYMENT: {
    title: 'Pagamento em dobro',
    action: 'Estorne o pagamento excedente no painel do Mercado Pago.',
  },
  AMOUNT_MISMATCH: {
    title: 'Valor diferente do pedido',
    action: 'Não envie; confira o valor no Mercado Pago e estorne ou cobre a diferença.',
  },
  PAYMENT_REVERSED: {
    title: 'Estorno, chargeback ou mediação',
    action: 'Suspenda o envio e acompanhe a disputa no Mercado Pago.',
  },
  RECONCILIATION_STOPPED: {
    title: 'Conciliação parou',
    action:
      'O Mercado Pago falhou 8 vezes seguidas; confira o pagamento no painel do MP e use "Retomar conciliação".',
  },
};

/** Texto de um tipo ainda sem orientação própria. */
export const genericAlertGuide: AlertGuide = {
  title: 'Alerta de pagamento',
  action: 'Confira o pagamento no painel do Mercado Pago e o pedido antes de seguir.',
};

/** Título e orientação do tipo; um tipo desconhecido cai no texto genérico. */
export function alertGuide(type: string): AlertGuide {
  return Object.hasOwn(paymentAlertGuides, type)
    ? paymentAlertGuides[type as PaymentAlertType]
    : genericAlertGuide;
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export const adminAlertErrorCodeSchema = z.enum([
  'ALERT_ALREADY_RESOLVED',
  'ALERT_NOT_RESUMABLE',
  'RECONCILIATION_NOT_STOPPED',
]);
export type AdminAlertErrorCode = z.infer<typeof adminAlertErrorCodeSchema>;

/** Mensagens dos `409` das rotas de alerta, exibidas no painel. */
export const adminAlertErrorMessages: Record<AdminAlertErrorCode, string> = {
  ALERT_ALREADY_RESOLVED: 'Este alerta já foi marcado como resolvido.',
  ALERT_NOT_RESUMABLE: 'Só alertas "Conciliação parou" permitem retomar a conciliação.',
  RECONCILIATION_NOT_STOPPED:
    'A conciliação deste pagamento não está parada: ela já foi retomada ou o Mercado Pago respondeu.',
};

/** Corpo dos `409` com código de `POST /api/admin/alerts/:id/*`. */
export const adminAlertErrorResponseSchema = z.object({
  statusCode: z.literal(409),
  code: adminAlertErrorCodeSchema,
  message: z.string(),
});
export type AdminAlertErrorResponse = z.infer<typeof adminAlertErrorResponseSchema>;
