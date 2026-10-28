import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { createDatabase } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { seed } from '../src/db/seed';
import {
  PixProviderError,
  type CreatePixInput,
  type CreatedPixPayment,
  type MercadoPagoClient,
  type ProviderPayment,
} from '../src/payments/mercadopago.client';
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

export const QR_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface MercadoPagoMock {
  /** Estado dos pagamentos "no Mercado Pago", por id. */
  remote: Map<string, ProviderPayment>;
  createSpy: jest.SpyInstance<Promise<CreatedPixPayment>, [CreatePixInput]>;
  getSpy: jest.SpyInstance<Promise<ProviderPayment>, [string]>;
  cancelSpy: jest.SpyInstance<Promise<ProviderPayment>, [string]>;
}

/**
 * Substitui as chamadas do cliente do Mercado Pago com `jest.spyOn`, guardando o estado num
 * `Map`. Como o Mercado Pago: a mesma chave de idempotência devolve o mesmo pagamento, id
 * desconhecido é 404, e cancelar um Pix já aprovado devolve o pagamento aprovado.
 */
export function mockMercadoPago(client: MercadoPagoClient): MercadoPagoMock {
  const remote = new Map<string, ProviderPayment>();
  const byKey = new Map<string, string>();
  let nextId = 1_000_000;
  const find = (id: string) => {
    const payment = remote.get(id);
    if (!payment) throw new PixProviderError('Mercado Pago respondeu 404.');
    return payment;
  };
  const createSpy = jest.spyOn(client, 'createPixPayment').mockImplementation(async (input) => {
    await sleep(10);
    let id = byKey.get(input.idempotencyKey);
    if (!id) {
      id = String(nextId++);
      byKey.set(input.idempotencyKey, id);
      remote.set(id, {
        id,
        status: 'pending',
        externalReference: input.orderId,
        amountCents: input.amountCents,
        currency: 'BRL',
        dateApproved: null,
        dateLastUpdated: null,
      });
    }
    return { ...remote.get(id)!, qrCode: `00020126-pix-ficticio-${id}`, qrCodeBase64: QR_BASE64 };
  });
  const getSpy = jest.spyOn(client, 'getPayment').mockImplementation(async (id) => {
    await sleep(10);
    return { ...find(id) };
  });
  const cancelSpy = jest.spyOn(client, 'cancelPayment').mockImplementation(async (id) => {
    await sleep(10);
    const payment = find(id);
    if (payment.status === 'pending') {
      remote.set(id, { ...payment, status: 'cancelled', dateLastUpdated: new Date() });
    }
    return { ...remote.get(id)! };
  });
  return { remote, createSpy, getSpy, cancelSpy };
}
