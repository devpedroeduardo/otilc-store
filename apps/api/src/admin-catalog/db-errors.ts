/**
 * Nome da restrição UNIQUE violada (código 23505 do Postgres), ou `null` se o erro for outro.
 * A Drizzle embrulha o erro do `pg` em `DrizzleQueryError`, com o original em `cause`.
 */
export function uniqueViolation(err: unknown): string | null {
  for (let current = err, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== 'object') return null;
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (code === '23505') return typeof constraint === 'string' ? constraint : '';
    current = cause;
  }
  return null;
}
