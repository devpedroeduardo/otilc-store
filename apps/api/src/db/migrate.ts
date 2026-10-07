import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { createDatabase } from './client';

/** Aplica as migrations SQL da pasta drizzle/. Usado no deploy, no CI e nos testes. */
export async function runMigrations(url: string): Promise<void> {
  const { db, pool } = createDatabase(url);
  try {
    await migrate(db, { migrationsFolder: path.join(__dirname, '..', '..', 'drizzle') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Defina DATABASE_URL.');
  runMigrations(url)
    .then(() => console.log('Migrations aplicadas.'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
