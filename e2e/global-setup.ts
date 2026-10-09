import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createAdminUser } from '../apps/api/src/admin-auth/new-admin';
import { runMigrations } from '../apps/api/src/db/migrate';
import { seed } from '../apps/api/src/db/seed';
import { withDb } from './support/db';
import { assertE2EDatabaseUrl, E2E_DATABASE_URL } from './support/env';

/**
 * Banco limpo a cada execução: migrações, Drop 00 do seed e dois admins (OWNER e STAFF).
 * As senhas são geradas aqui e passadas aos testes só por process.env (os workers herdam).
 */
export default async function globalSetup(): Promise<void> {
  assertE2EDatabaseUrl(E2E_DATABASE_URL);
  await runMigrations(E2E_DATABASE_URL);
  await withDb(async (db) => {
    await seed(db);
    await db.execute(sql`TRUNCATE admin_sessions, admin_users`);
    for (const role of ['OWNER', 'STAFF'] as const) {
      const email = `${role.toLowerCase()}-e2e@example.test`;
      const password = randomBytes(24).toString('base64url');
      await createAdminUser(db, { email, name: `E2E ${role}`, role, password });
      process.env[`E2E_${role}_EMAIL`] = email;
      process.env[`E2E_${role}_PASSWORD`] = password;
    }
  });
}
