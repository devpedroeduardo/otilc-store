import { z } from 'zod';
import { integer } from './zod-compat';
import { orderStatusSchema } from './admin';

// ---------------------------------------------------------------------------
// Cobrança Pix (spec-014). Contrato dos endpoints em `docs/api/pagamentos.md`.
// ---------------------------------------------------------------------------

/** Status da cobrança Pix como a loja vê, independente do provedor. */
export const pixChargeStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'REFUNDED',
]);
export type PixChargeStatus = z.infer<typeof pixChargeStatusSchema>;

/** Cobrança Pix devolvida por `POST` e `GET /api/orders/:id/pix`. */
export const pixChargeSchema = z.object({
  orderId: z.uuid(),
  /** Status do pedido no mesmo instante: a página para de consultar quando ele sai de PENDING_PAYMENT. */
  orderStatus: orderStatusSchema,
  status: pixChargeStatusSchema,
  /** Sempre o total do pedido calculado no servidor. */
  amountCents: z.number().check(integer).positive(),
  /** Código "copia e cola". */
  qrCode: z.string().min(1),
  /** Imagem PNG do QR code em base64, sem o prefixo `data:`. */
  qrCodeBase64: z.base64().min(1),
  /** Prazo para pagar: o vencimento da reserva do pedido. */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type PixChargeDto = z.infer<typeof pixChargeSchema>;

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export const pixErrorCodeSchema = z.enum(['PIX_UNAVAILABLE', 'ORDER_NOT_PAYABLE']);
export type PixErrorCode = z.infer<typeof pixErrorCodeSchema>;

/** Status HTTP de cada código de erro do Pix. */
export const pixErrorStatus = {
  PIX_UNAVAILABLE: 503,
  ORDER_NOT_PAYABLE: 409,
} as const satisfies Record<PixErrorCode, number>;

/** Mensagens exibidas ao cliente. */
export const pixErrorMessages: Record<PixErrorCode, string> = {
  PIX_UNAVAILABLE: 'O pagamento por Pix está indisponível no momento. Tente de novo em instantes.',
  ORDER_NOT_PAYABLE:
    'Este pedido não pode mais ser pago: ele já foi pago, foi cancelado ou o prazo para pagamento acabou.',
};

/** Corpo de erro de `POST /api/orders/:id/pix` com código (`409` e `503`). */
export const pixErrorResponseSchema = z.object({
  statusCode: z.number().check(integer),
  code: pixErrorCodeSchema,
  message: z.string(),
});
export type PixErrorResponse = z.infer<typeof pixErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Webhook do Mercado Pago (`POST /api/webhooks/mercadopago`)
// ---------------------------------------------------------------------------

/**
 * Id de uma order do Mercado Pago (API de Orders, spec-021): `ORD` seguido de letras maiúsculas e
 * dígitos (ex.: `ORD01JP84C939T20S0P1DN382FQ6K`). É o id guardado em `payments.provider_payment_id`
 * e o único aceito nas chamadas ao Mercado Pago e nas notificações `type=order`.
 */
export const mercadoPagoOrderIdSchema = z
  .string()
  .regex(/^ORD[0-9A-Z]{26,40}$/, 'Id de order inválido.');

/**
 * Id do recurso notificado, de qualquer tipo. Só depois de saber que a notificação é `type=order`
 * o id passa por `mercadoPagoOrderIdSchema`: outros tipos (ex.: `payment`, de id numérico) são
 * ignorados com `200`, sem erro.
 */
const notificationResourceId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/, 'Id inválido.');

/**
 * Query da notificação. `data.id` é o id que entra no texto assinado do `x-signature`,
 * por isso é a fonte do id processado. Campos desconhecidos são descartados.
 */
export const mercadoPagoWebhookQuerySchema = z.object({
  'data.id': notificationResourceId,
  type: z.string().trim().min(1).max(64).optional(),
});
export type MercadoPagoWebhookQuery = z.infer<typeof mercadoPagoWebhookQuerySchema>;

/**
 * Corpo da notificação. Só `type` e `data.id` são lidos; o resto (inclusive qualquer status)
 * é descartado. O status vem sempre da consulta à order na API do Mercado Pago.
 */
export const mercadoPagoWebhookBodySchema = z.object({
  type: z.string().trim().min(1).max(64),
  action: z.string().trim().max(64).optional(),
  data: z.object({
    id: z
      .union([z.string(), z.number().check(integer).nonnegative()])
      .transform(String)
      .pipe(notificationResourceId),
  }),
});
export type MercadoPagoWebhookBody = z.infer<typeof mercadoPagoWebhookBodySchema>;
