import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mercadoPagoWebhookBodySchema,
  mercadoPagoWebhookQuerySchema,
  pixChargeSchema,
  pixChargeStatusSchema,
  pixErrorCodeSchema,
  pixErrorMessages,
  pixErrorResponseSchema,
  pixErrorStatus,
} from './payments';

const charge = {
  orderId: '3b241101-e2bb-4255-8caf-4136c566a962',
  orderStatus: 'PENDING_PAYMENT',
  status: 'PENDING',
  amountCents: 25980,
  qrCode: '00020126580014br.gov.bcb.pix0136teste-copia-e-cola-ficticio5204000053039865802BR',
  qrCodeBase64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  expiresAt: '2026-10-28T15:30:00.000Z',
};

test('status da cobrança aceita só os 5 valores do contrato', () => {
  for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED']) {
    assert.equal(pixChargeStatusSchema.safeParse(status).success, true, status);
  }
  for (const status of ['approved', 'CANCELED', 'PAID', '']) {
    assert.equal(pixChargeStatusSchema.safeParse(status).success, false, status);
  }
});

test('cobrança válida passa e campos extras são descartados', () => {
  const parsed = pixChargeSchema.parse({ ...charge, payerEmail: 'ana@example.com' });
  assert.deepEqual(parsed, charge);
});

test('cobrança aceita expiresAt com offset de fuso', () => {
  const parsed = pixChargeSchema.safeParse({ ...charge, expiresAt: '2026-10-28T12:30:00-03:00' });
  assert.equal(parsed.success, true);
});

test('cobrança recusa valor zero, negativo ou fracionado', () => {
  for (const amountCents of [0, -100, 10.5]) {
    assert.equal(pixChargeSchema.safeParse({ ...charge, amountCents }).success, false, amountCents);
  }
});

test('cobrança recusa id que não é uuid, status de pedido desconhecido e data sem fuso', () => {
  assert.equal(pixChargeSchema.safeParse({ ...charge, orderId: 'pedido-1' }).success, false);
  assert.equal(pixChargeSchema.safeParse({ ...charge, orderStatus: 'APPROVED' }).success, false);
  assert.equal(
    pixChargeSchema.safeParse({ ...charge, expiresAt: '2026-10-28T15:30:00' }).success,
    false,
  );
});

test('cobrança recusa QR vazio e imagem que não é base64', () => {
  assert.equal(pixChargeSchema.safeParse({ ...charge, qrCode: '' }).success, false);
  assert.equal(pixChargeSchema.safeParse({ ...charge, qrCodeBase64: '' }).success, false);
  assert.equal(
    pixChargeSchema.safeParse({ ...charge, qrCodeBase64: 'data:image/png;base64,iVBORw0KGgo=' })
      .success,
    false,
  );
});

test('todo código de erro tem status HTTP e mensagem em português', () => {
  assert.deepEqual(pixErrorStatus, { PIX_UNAVAILABLE: 503, ORDER_NOT_PAYABLE: 409 });
  for (const code of pixErrorCodeSchema.options) {
    assert.ok(pixErrorMessages[code].length > 10, code);
  }
  assert.match(pixErrorMessages.PIX_UNAVAILABLE, /indisponível/);
  assert.match(pixErrorMessages.ORDER_NOT_PAYABLE, /não pode mais ser pago/);
});

test('corpo de erro do Pix é reconhecido pelo código', () => {
  const body = {
    statusCode: 503,
    code: 'PIX_UNAVAILABLE',
    message: pixErrorMessages.PIX_UNAVAILABLE,
    error: 'Service Unavailable',
  };
  assert.equal(pixErrorResponseSchema.parse(body).code, 'PIX_UNAVAILABLE');
  assert.equal(pixErrorResponseSchema.safeParse({ ...body, code: 'OUTRO' }).success, false);
});

test('query do webhook exige data.id alfanumérico', () => {
  assert.deepEqual(mercadoPagoWebhookQuerySchema.parse({ 'data.id': '123456', type: 'payment' }), {
    'data.id': '123456',
    type: 'payment',
  });
  assert.equal(mercadoPagoWebhookQuerySchema.safeParse({ 'data.id': 'AbC123' }).success, true);
  for (const id of ['', '12;ts=1', '../1', 'a'.repeat(65)]) {
    assert.equal(mercadoPagoWebhookQuerySchema.safeParse({ 'data.id': id }).success, false, id);
  }
  assert.equal(mercadoPagoWebhookQuerySchema.safeParse({ type: 'payment' }).success, false);
});

test('corpo do webhook lê só tipo e id, e descarta o status enviado', () => {
  const parsed = mercadoPagoWebhookBodySchema.parse({
    id: 12345,
    live_mode: false,
    type: 'payment',
    date_created: '2026-10-28T10:04:58.396-03:00',
    user_id: 44444,
    api_version: 'v1',
    action: 'payment.updated',
    status: 'approved',
    data: { id: '999999999', status: 'approved' },
  });
  assert.deepEqual(parsed, {
    type: 'payment',
    action: 'payment.updated',
    data: { id: '999999999' },
  });
});

test('corpo do webhook aceita id numérico e o converte em texto', () => {
  const parsed = mercadoPagoWebhookBodySchema.parse({ type: 'payment', data: { id: 999999999 } });
  assert.equal(parsed.data.id, '999999999');
});

test('corpo do webhook recusa formato inválido', () => {
  for (const body of [
    {},
    { type: 'payment' },
    { type: '', data: { id: '1' } },
    { type: 'payment', data: { id: '' } },
    { type: 'payment', data: { id: 1.5 } },
    { type: 'payment', data: { id: { $gt: '' } } },
  ]) {
    assert.equal(mercadoPagoWebhookBodySchema.safeParse(body).success, false, JSON.stringify(body));
  }
});
