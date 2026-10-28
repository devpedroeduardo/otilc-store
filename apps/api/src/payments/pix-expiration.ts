/**
 * Validade do Pix enviada ao Mercado Pago (`date_of_expiration`). Único ponto deste cálculo.
 *
 * O Mercado Pago exige validade entre 30 minutos e 30 dias a partir da emissão (doc oficial,
 * "Integrar Pix"), e a reserva do pedido dura 30 minutos: o tempo restante do pedido é sempre
 * menor que o mínimo. Decisão do Pedro na spec-014 (Q13): o Pix vale 30 minutos a partir da
 * criação, mais 1 minuto de folga para a latência até o provedor. O prazo do pedido continua em
 * `orders.expires_at`; pagamento aprovado depois dele cai em PAID_AFTER_EXPIRY.
 */
export const PIX_MIN_VALIDITY_MINUTES = 30;
const PROVIDER_LATENCY_MARGIN_MINUTES = 1;

export function pixExpiresAt(now: Date): Date {
  return new Date(
    now.getTime() + (PIX_MIN_VALIDITY_MINUTES + PROVIDER_LATENCY_MARGIN_MINUTES) * 60_000,
  );
}
