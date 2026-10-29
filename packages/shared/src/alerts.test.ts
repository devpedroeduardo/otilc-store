import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminAlertQuerySchema,
  alertGuide,
  genericAlertGuide,
  paymentAlertGuides,
  paymentAlertTypeSchema,
} from './alerts';

test('orientação cobre os 5 tipos, com título e o que fazer', () => {
  assert.deepEqual(
    Object.keys(paymentAlertGuides).sort(),
    [...paymentAlertTypeSchema.options].sort(),
  );
  for (const type of paymentAlertTypeSchema.options) {
    const guide = alertGuide(type);
    assert.notEqual(guide, genericAlertGuide, type);
    assert.ok(guide.title.length > 0 && guide.action.length > 0, type);
  }
  assert.equal(alertGuide('RECONCILIATION_STOPPED').title, 'Conciliação parou');
  assert.match(alertGuide('RECONCILIATION_STOPPED').action, /"Retomar conciliação"/);
});

test('tipo sem orientação cai no texto genérico, inclusive nomes herdados de Object', () => {
  for (const type of ['NEW_ALERT', '', 'toString', '__proto__', 'constructor']) {
    assert.equal(alertGuide(type), genericAlertGuide, type);
  }
});

test('query: padrão abertos, página 1, 20 por página', () => {
  assert.deepEqual(adminAlertQuerySchema.parse({}), {
    situacao: 'abertos',
    pagina: 1,
    porPagina: 20,
  });
});

test('query: aceita situação, tipo e paginação válidos (vindos da URL, como texto)', () => {
  assert.deepEqual(
    adminAlertQuerySchema.parse({
      situacao: 'resolvidos',
      tipo: 'DUPLICATE_PAYMENT',
      pagina: '3',
      porPagina: '100',
    }),
    { situacao: 'resolvidos', tipo: 'DUPLICATE_PAYMENT', pagina: 3, porPagina: 100 },
  );
  assert.equal(adminAlertQuerySchema.parse({ situacao: 'todos' }).situacao, 'todos');
});

test('query: recusa situação, tipo e paginação inválidos', () => {
  for (const query of [
    { situacao: 'abertas' },
    { situacao: 'ABERTOS' },
    { tipo: 'paid_after_expiry' },
    { tipo: 'OUTRO' },
    { pagina: '0' },
    { pagina: '1.5' },
    { pagina: '501' },
    { porPagina: '0' },
    { porPagina: '101' },
    { porPagina: 'abc' },
  ]) {
    assert.equal(adminAlertQuerySchema.safeParse(query).success, false, JSON.stringify(query));
  }
});
