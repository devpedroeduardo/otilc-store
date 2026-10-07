import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBRL, toCents } from './money';

test('formata centavos em reais', () => {
  assert.equal(formatBRL(70000).replace(/\s/g, ' '), 'R$ 700,00');
  assert.equal(formatBRL(1990).replace(/\s/g, ' '), 'R$ 19,90');
});

test('converte reais em centavos sem erro de ponto flutuante', () => {
  assert.equal(toCents(19.9), 1990);
  assert.equal(toCents(0.1 + 0.2), 30);
});
