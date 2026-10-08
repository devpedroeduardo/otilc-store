import { createHash, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createAdminUser, newAdminSchema } from '../admin-auth/new-admin';
import { loadEnv } from '../config/env';
import { createDatabase } from '../db/client';

/**
 * Cria um usuário do painel pelo terminal (ADR 0002): `npm run admin:create -w @otilc/api`.
 * Tudo é perguntado interativamente; a senha é digitada sem eco e nunca passa por argumento,
 * para não ficar no histórico do shell nem na lista de processos.
 */
/** Erro com mensagem escrita aqui, segura para mostrar no terminal. */
class ScriptError extends Error {}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new ScriptError('Este script não aceita argumentos: os dados são pedidos pelo terminal.');
  }
  if (!process.stdin.isTTY) {
    throw new ScriptError('Rode num terminal interativo: a senha é digitada sem eco.');
  }
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // A mensagem do loadEnv lista só nomes de variáveis e regras, nunca valores.
    throw new ScriptError(err instanceof Error ? err.message : 'Configuração inválida.');
  }

  // Saída que pode ser silenciada enquanto a senha é digitada.
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });

  const ask = (question: string) => rl.question(question);
  const askSecret = async (question: string): Promise<string> => {
    process.stdout.write(question);
    muted = true;
    try {
      return await rl.question('');
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  };

  let parsed;
  try {
    const email = await ask('E-mail: ');
    const name = await ask('Nome: ');
    const role = await ask('Papel (OWNER ou STAFF): ');
    const password = await askSecret('Senha (mínimo 12 caracteres): ');
    const confirmation = await askSecret('Repita a senha: ');
    if (!sameSecret(password, confirmation)) throw new ScriptError('As senhas não conferem.');
    parsed = newAdminSchema.safeParse({ email, name, role, password });
  } finally {
    rl.close();
  }

  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new ScriptError(`Dados inválidos:\n${problems.join('\n')}`);
  }

  const { db, pool } = createDatabase(env.DATABASE_URL);
  try {
    const user = await createAdminUser(db, parsed.data);
    console.log(`Admin criado: ${user.email} (${user.role}).`);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ScriptError('Já existe um admin com esse e-mail.');
    throw err;
  } finally {
    await pool.end();
  }
}

/** Compara senhas sem `===`: digests de mesmo tamanho e `timingSafeEqual`. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Código SQLSTATE do Postgres, procurando também no `cause` (o Drizzle embrulha o erro do pg). */
function pgErrorCode(err: unknown, depth = 0): string | undefined {
  if (typeof err !== 'object' || err === null || depth > 3) return undefined;
  if ('code' in err && typeof err.code === 'string') return err.code;
  return 'cause' in err ? pgErrorCode(err.cause, depth + 1) : undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

main().catch((err: unknown) => {
  // Erros do driver/Drizzle citam os parâmetros da query (inclusive o hash): não são exibidos.
  if (err instanceof ScriptError) {
    console.error(err.message);
  } else {
    const code = pgErrorCode(err);
    console.error(`Falha ao criar o admin${code ? ` (código ${code})` : ''}.`);
  }
  process.exit(1);
});
