import { mergeCartItems } from '@otilc/shared';

/**
 * Ordem única de trava das variações: junta as linhas repetidas e ordena por `variantId`.
 *
 * Toda transação que atualiza mais de uma variação (checkout, painel e job de expiração) precisa
 * travar as linhas nessa mesma ordem. Se uma trava A→B e outra B→A, cada uma fica esperando a
 * outra e o Postgres aborta uma delas com deadlock (40P01).
 */
export function lockOrder(rows: readonly { variantId: string; quantity: number }[]) {
  return mergeCartItems([...rows]).sort((a, b) => a.variantId.localeCompare(b.variantId));
}
