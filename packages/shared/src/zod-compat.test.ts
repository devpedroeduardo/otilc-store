import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { integer } from './index';

const messages = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues.map((i) => i.message);

test('integer: aceita inteiros e reprova fração, NaN e texto', () => {
  const schema = z.number().check(integer);
  assert.equal(schema.safeParse(3).success, true);
  assert.equal(schema.safeParse(-2).success, true);
  assert.deepEqual(messages(schema, 2.5), ['Expected integer, received float']);
  assert.deepEqual(messages(schema, Number.NaN), ['Expected number, received nan']);
  assert.deepEqual(messages(schema, '3'), ['Expected number, received string']);
});

test('integer: não interrompe as checagens seguintes', () => {
  assert.deepEqual(messages(z.number().check(integer).max(10), 10.5), [
    'Expected integer, received float',
    'Number must be less than or equal to 10',
  ]);
});

test('mensagens do Zod 3: limites exclusivos e exatos', () => {
  assert.deepEqual(messages(z.number().lt(5), 5), ['Number must be less than 5']);
  assert.deepEqual(messages(z.string().length(3), 'ab'), [
    'String must contain exactly 3 character(s)',
  ]);
  assert.deepEqual(messages(z.array(z.string()).length(1), []), [
    'Array must contain exactly 1 element(s)',
  ]);
});

test('mensagens do Zod 3: chaves desconhecidas e formatos', () => {
  assert.deepEqual(messages(z.object({}).strict(), { a: 1, b: 2 }), [
    "Unrecognized key(s) in object: 'a', 'b'",
  ]);
  assert.deepEqual(messages(z.string().email(), 'x'), ['Invalid email']);
  assert.deepEqual(messages(z.string().regex(/^a$/), 'b'), ['Invalid']);
});

test('mensagem do schema continua tendo prioridade sobre o mapa', () => {
  assert.deepEqual(messages(z.string().min(2, 'Curto demais.'), 'a'), ['Curto demais.']);
});
