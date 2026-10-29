import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** Variáveis que decidem o SSL da conexão: o `process.env` ou o `Env` já validado. */
export interface DatabaseSslSource {
  NODE_ENV?: string;
  DATABASE_CA_CERT?: string;
}

// No `pg`, parâmetros de SSL na URL sobrescrevem o `ssl` do Pool (`sslmode=no-verify` desliga a
// verificação). Com o CA configurado, eles saem da URL e vale só a configuração abaixo.
const URL_SSL_PARAMS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'];

function withoutSslParams(url: string): string {
  const parsed = new URL(url);
  const present = URL_SSL_PARAMS.filter((p) => parsed.searchParams.has(p));
  if (present.length === 0) return url;
  for (const p of present) parsed.searchParams.delete(p);
  return parsed.toString();
}

/**
 * Configuração do pool, a mesma na API e no migrator (spec-016). Em produção exige
 * `DATABASE_CA_CERT` e usa SSL verificando o certificado e o host. Fora de produção, sem a
 * variável, conecta sem SSL como no Postgres local.
 */
export function poolConfig(url: string, source: DatabaseSslSource = process.env): PoolConfig {
  const ca = source.DATABASE_CA_CERT || undefined;
  if (source.NODE_ENV === 'production' && !ca) {
    throw new Error('Configuração inválida: DATABASE_CA_CERT: Obrigatória em produção.');
  }
  if (!ca) return { connectionString: url, max: 10 };
  return {
    connectionString: withoutSslParams(url),
    max: 10,
    ssl: { rejectUnauthorized: true, ca },
  };
}

export function createDatabase(
  url: string,
  source: DatabaseSslSource = process.env,
): { db: Database; pool: Pool } {
  const pool = new Pool(poolConfig(url, source));
  return { db: drizzle(pool, { schema }), pool };
}

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
