import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { seed } from '../src/db/seed';
import type { Pool } from 'pg';

/** Banco separado para os testes. No CI ele vem do serviço Postgres do GitHub Actions. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://otilc:otilc@localhost:5432/otilc_test';

export interface TestContext {
  app: INestApplication;
  db: Database;
  pool: Pool;
}

export async function setupTestApp(): Promise<TestContext> {
  await runMigrations(TEST_DATABASE_URL);
  const { db, pool } = createDatabase(TEST_DATABASE_URL);
  await seed(db);
  const app = await createApp(
    loadEnv({ NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, ORDER_HOLD_MINUTES: '30' }),
  );
  // Escuta numa porta livre: as requisições simultâneas dos testes usam o mesmo servidor.
  await app.listen(0);
  return { app, db, pool };
}

export async function teardownTestApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.pool.end();
}

export async function resetData(db: Database): Promise<void> {
  await seed(db);
}
