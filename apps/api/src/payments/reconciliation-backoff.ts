/**
 * Teto e backoff da conciliação (spec-020). Toda falha da consulta ao Mercado Pago conta igual
 * (404, 5xx, rede, tempo esgotado): o client não distingue, e uma queda longa também merece alerta.
 */

/** Falhas consecutivas que param a conciliação de um pagamento (alerta RECONCILIATION_STOPPED). */
export const RECONCILIATION_MAX_FAILURES = 8;

/** Maior espera entre duas consultas de um pagamento que vem falhando. */
export const RECONCILIATION_MAX_DELAY_MS = 60 * 60_000;

/**
 * Espera até a próxima consulta depois da `failures`-ésima falha consecutiva: o intervalo da
 * rodada dobrando a cada falha, no máximo 1 h. No padrão de 5 min: 5, 10, 20, 40, 60, 60, 60 min.
 */
export function reconciliationDelayMs(failures: number, intervalMs: number): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new RangeError(`Número de falhas inválido: ${failures}.`);
  }
  // Limita o expoente antes de calcular: 2^(n−1) não estoura com n grande.
  const exponent = Math.min(failures - 1, 30);
  return Math.min(intervalMs * 2 ** exponent, RECONCILIATION_MAX_DELAY_MS);
}
