import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogQuerySchema } from './catalog';

test('aplica valores padrão no catálogo', () => {
  assert.deepEqual(catalogQuerySchema.parse({}), { ordem: 'destaque', pagina: 1, porPagina: 24 });
});

test('converte números vindos da query string', () => {
  const q = catalogQuerySchema.parse({ pagina: '2', porPagina: '12', categoria: 'tenis' });
  assert.equal(q.pagina, 2);
  assert.equal(q.porPagina, 12);
});

test('recusa categoria com caracteres inválidos', () => {
  assert.equal(catalogQuerySchema.safeParse({ categoria: "tenis' OR 1=1" }).success, false);
});

test('limita o tamanho da página', () => {
  assert.equal(catalogQuerySchema.safeParse({ porPagina: '500' }).success, false);
});
