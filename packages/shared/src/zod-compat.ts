import { z } from 'zod';

/**
 * Mensagens padrão de validação no formato do Zod 3.
 *
 * As mensagens fazem parte do contrato da API (`errors[]` do ZodValidationPipe) e a loja as mostra.
 * O Zod 4 mudou os textos padrão; este mapa devolve os textos de antes para que a troca de versão
 * (spec-011) não mude o contrato. Mensagens passadas no próprio schema (ex.: 'E-mail inválido.')
 * continuam tendo prioridade. Códigos não tratados aqui caem no texto padrão do Zod 4.
 */
export const zod3ErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type': {
      const received = parsedType(issue.input);
      if (received === 'undefined') return 'Required';
      if (issue.expected === 'int') return 'Expected integer, received float';
      return `Expected ${issue.expected}, received ${received}`;
    }
    case 'invalid_value': {
      if (issue.input === undefined) return 'Required';
      const expected = issue.values
        .map((v) => (typeof v === 'string' ? `'${v}'` : String(v)))
        .join(' | ');
      if (typeof issue.input === 'string') {
        return `Invalid enum value. Expected ${expected}, received '${issue.input}'`;
      }
      return `Expected ${expected}, received ${parsedType(issue.input)}`;
    }
    case 'too_small': {
      const { minimum: min, inclusive, exact } = issue;
      switch (issue.origin) {
        case 'array':
          return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${min} element(s)`;
        case 'string':
          return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${min} character(s)`;
        case 'number':
        case 'int':
          return `Number must be ${exact ? 'exactly equal to' : inclusive ? 'greater than or equal to' : 'greater than'} ${min}`;
        case 'date':
          return `Date must be ${exact ? 'exactly equal to' : inclusive ? 'greater than or equal to' : 'greater than'} ${new Date(Number(min))}`;
        default:
          return 'Invalid input';
      }
    }
    case 'too_big': {
      const { maximum: max, inclusive, exact } = issue;
      switch (issue.origin) {
        case 'array':
          return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${max} element(s)`;
        case 'string':
          return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${max} character(s)`;
        case 'number':
        case 'int':
          return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${max}`;
        case 'date':
          return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(max))}`;
        default:
          return 'Invalid input';
      }
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    case 'invalid_format':
      return issue.format === 'regex' ? 'Invalid' : `Invalid ${issue.format}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${issue.keys.map((k) => `'${k}'`).join(', ')}`;
    case 'invalid_union':
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
};

/**
 * Inteiro, como o `.int()` do Zod 3: use `z.number().check(integer)`.
 * O `.int()` do Zod 4 interrompe as checagens seguintes quando falha, e o erro de `min`/`max` de um
 * valor como -1,5 sumiria da resposta. Este check reprova não inteiros e deixa as demais rodarem.
 */
export const integer = z.check<number>((ctx) => {
  if (!Number.isInteger(ctx.value)) {
    ctx.issues.push({ code: 'invalid_type', expected: 'int', input: ctx.value, continue: true });
  }
});

/** Nome do tipo recebido, como o Zod 3 escrevia em "Expected X, received Y". */
function parsedType(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  if (typeof input === 'number') return Number.isNaN(input) ? 'nan' : 'number';
  if (input instanceof Map) return 'map';
  if (input instanceof Set) return 'set';
  if (input instanceof Date) return 'date';
  if (input instanceof Promise) return 'promise';
  return typeof input;
}

z.config({ customError: zod3ErrorMap });
