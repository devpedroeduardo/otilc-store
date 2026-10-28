import { createHmac, randomBytes } from 'node:crypto';
import { createApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { createDatabase } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { seed } from '../src/db/seed';
import { TEST_DATABASE_URL, type TestContext } from './setup';

/** Segredo do webhook gerado a cada execução: nenhum valor real nos testes. */
export const WEBHOOK_SECRET = randomBytes(32).toString('hex');

/**
 * Como `setupTestApp`, mas com o Pix ligado (variáveis fictícias). O cliente do Mercado Pago real
 * é criado, e os testes substituem as duas chamadas com `jest.spyOn`: nada sai para a rede.
 */
export async function setupPixTestApp(): Promise<TestContext> {
  await runMigrations(TEST_DATABASE_URL);
  const { db, pool } = createDatabase(TEST_DATABASE_URL);
  await seed(db);
  const app = await createApp(
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      ORDER_HOLD_MINUTES: '30',
      MP_ACCESS_TOKEN: `TEST-${randomBytes(16).toString('hex')}`,
      MP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MP_NOTIFICATION_URL: 'https://api.example.test/api/webhooks/mercadopago',
    }),
  );
  await app.listen(0);
  return { app, db, pool };
}

/** Header `x-signature` como o Mercado Pago monta (ts em segundos). */
export function signature(
  dataId: string,
  requestId: string,
  ts = Math.floor(Date.now() / 1000),
  secret = WEBHOOK_SECRET,
): string {
  const v1 = createHmac('sha256', secret)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  return `ts=${ts},v1=${v1}`;
}
