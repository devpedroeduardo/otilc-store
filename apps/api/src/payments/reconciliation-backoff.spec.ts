import {
  RECONCILIATION_MAX_DELAY_MS,
  RECONCILIATION_MAX_FAILURES,
  reconciliationDelayMs,
} from './reconciliation-backoff';

describe('reconciliationDelayMs', () => {
  const minute = 60_000;

  it('no intervalo padrão (5 min): 5, 10, 20, 40, 60, 60, 60 min até o teto', () => {
    const delays = Array.from({ length: RECONCILIATION_MAX_FAILURES - 1 }, (_, i) =>
      reconciliationDelayMs(i + 1, 5 * minute),
    );
    expect(delays.map((d) => d / minute)).toEqual([5, 10, 20, 40, 60, 60, 60]);
  });

  it('dobra a cada falha a partir do intervalo da rodada', () => {
    expect(reconciliationDelayMs(1, 30_000)).toBe(30_000);
    expect(reconciliationDelayMs(2, 30_000)).toBe(60_000);
    expect(reconciliationDelayMs(3, 30_000)).toBe(120_000);
    expect(reconciliationDelayMs(7, 30_000)).toBe(32 * minute);
  });

  it('satura em 1 h, inclusive com intervalo de 1 h e muitas falhas', () => {
    expect(reconciliationDelayMs(8, 30_000)).toBe(RECONCILIATION_MAX_DELAY_MS);
    expect(reconciliationDelayMs(1, 60 * minute)).toBe(RECONCILIATION_MAX_DELAY_MS);
    expect(reconciliationDelayMs(1_000, 5 * minute)).toBe(RECONCILIATION_MAX_DELAY_MS);
  });

  it.each([0, -1, 1.5, Number.NaN])('recusa número de falhas inválido (%p)', (failures) => {
    expect(() => reconciliationDelayMs(failures, 5 * minute)).toThrow(RangeError);
  });
});
