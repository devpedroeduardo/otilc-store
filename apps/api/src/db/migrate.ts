import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { createDatabase, type DatabaseSslSource } from './client';

/**
 * Aplica as migrations SQL da pasta drizzle/. Usado no Pre-Deploy Command do Render, no CI e nos
 * testes. Conecta com a mesma configuração (e o mesmo SSL) da API.
 */
export async function runMigrations(
  url: string,
  source: DatabaseSslSource = process.env,
): Promise<void> {
  const { db, pool } = createDatabase(url, source);
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
