import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDatabase, type Database } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { TEST_DATABASE_URL } from './setup';

/** As tabelas que a migração 0003 cobre. Tabela nova também precisa de RLS (ver o 2º teste). */
const TABLES = [
  'admin_sessions',
  'admin_users',
  'categories',
  'order_items',
  'orders',
  'product_images',
  'products',
  'variants',
];

type TableRls = {
  name: string;
  rls: boolean;
  forced: boolean;
};

describe('RLS nas tabelas do schema public (integração com Postgres)', () => {
  let db: Database;
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL);
    ({ db, pool } = createDatabase(TEST_DATABASE_URL));
  });
  afterAll(() => pool.end());

  async function publicTables(): Promise<TableRls[]> {
    const { rows } = await db.execute<TableRls>(sql`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `);
    return rows;
  }

  it('as 8 tabelas existem e têm RLS habilitado', async () => {
    const tables = await publicTables();
    const covered = tables.filter((t) => TABLES.includes(t.name));

    expect(covered.map((t) => t.name)).toEqual(TABLES);
    expect(covered.filter((t) => !t.rls)).toEqual([]);
  });

  it('payment_alerts (spec-015) existe e tem RLS habilitado', async () => {
    const tables = await publicTables();

    expect(tables.filter((t) => t.name === 'payment_alerts')).toEqual([
      { name: 'payment_alerts', rls: true, forced: false },
    ]);
  });

  it('toda tabela do schema public tem RLS habilitado', async () => {
    const tables = await publicTables();

    expect(tables.length).toBeGreaterThanOrEqual(TABLES.length);
    expect(tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
  });

  it('nenhuma tabela força RLS sobre a dona (a API conecta como dona)', async () => {
    const tables = await publicTables();

    expect(tables.filter((t) => t.forced).map((t) => t.name)).toEqual([]);
  });

  it('migrar de novo é no-op', async () => {
    const count = async () => {
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
      );
      return rows[0].n;
    };
    const before = await count();

    await runMigrations(TEST_DATABASE_URL);

    expect(await count()).toBe(before);
    expect(before).toBeGreaterThanOrEqual(4);
  });
});
