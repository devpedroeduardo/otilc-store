/**
 * Dinheiro é sempre guardado em centavos (inteiro) para evitar erro de arredondamento
 * de ponto flutuante. A formatação para reais acontece só na exibição.
 */
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: number): string {
  return brl.format(cents / 100);
}

export function toCents(reais: number): number {
  return Math.round(reais * 100);
}
