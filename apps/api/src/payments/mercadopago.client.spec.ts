import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  MercadoPagoClient,
  PixProviderError,
  isOrderId,
  isReversal,
  toChargeStatus,
} from './mercadopago.client';

// Token gerado na hora: nenhum valor real no teste.
const token = `TEST-${randomBytes(16).toString('hex')}`;
const orderId = '3b241101-e2bb-4255-8caf-4136c566a962';
const mpOrderId = 'ORD01JP84C939T20S0P1DN382FQ6K';
const qrCodeBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Resposta da criação como na doc da API de Orders (Pix pendente), com dados fictícios. */
const created = {
  id: mpOrderId,
  type: 'online',
  processing_mode: 'automatic',
  external_reference: orderId,
  total_amount: '259.80',
  country_code: 'BRA',
  status: 'action_required',
  status_detail: 'waiting_transfer',
  created_date: '2026-10-28T12:00:00.000Z',
  last_updated_date: '2026-10-28T12:00:00.000Z',
  payer: { email: 'ana@example.com', first_name: 'Ana' },
  transactions: {
    payments: [
      {
        id: 'PAY01JP84C939T20S0P1DN382FQ6M',
        amount: '259.80',
        status: 'action_required',
        status_detail: 'waiting_transfer',
        payment_method: {
          id: 'pix',
          type: 'bank_transfer',
          ticket_url: 'https://www.mercadopago.com.br/payments/ficticio/ticket',
          qr_code: '00020126580014br.gov.bcb.pix-ficticio',
          qr_code_base64: qrCodeBase64,
        },
      },
    ],
  },
};

const input = {
  orderId,
  orderNumber: 42,
  amountCents: 25980,
  payerEmail: 'ana@example.com',
  payerFirstName: 'Ana',
  expirationTime: 'PT31M',
  idempotencyKey: `otilc-pix-${orderId}-1`,
};

function fakeFetch(response: () => Promise<Response> | Response) {
  return jest.fn(async (..._args: Parameters<typeof fetch>) => response());
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('MercadoPagoClient', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('cria a order do Pix com valor em texto, referência, validade, pagador e idempotência', async () => {
    const fetchFn = fakeFetch(() => json(created, 201));
    const client = new MercadoPagoClient(token, fetchFn);

    const payment = await client.createPixPayment(input);

    expect(payment).toEqual({
      id: mpOrderId,
      status: 'action_required',
      statusDetail: 'waiting_transfer',
      externalReference: orderId,
      amountCents: 25980,
      paidAmountCents: null,
      currency: 'BRL',
      dateLastUpdated: new Date('2026-10-28T12:00:00.000Z'),
      qrCode: created.transactions.payments[0].payment_method.qr_code,
      qrCodeBase64,
    });
    // Nada do pagador sai do cliente.
    expect(JSON.stringify(payment)).not.toContain('ana@example.com');
    expect(JSON.stringify(payment)).not.toContain('Ana');

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.mercadopago.com/v1/orders');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': input.idempotencyKey,
    });
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toEqual({
      type: 'online',
      processing_mode: 'automatic',
      external_reference: orderId,
      description: 'Pedido OTILC #42',
      total_amount: '259.80',
      payer: { email: 'ana@example.com', first_name: 'Ana' },
      transactions: {
        payments: [
          {
            amount: '259.80',
            payment_method: { id: 'pix', type: 'bank_transfer' },
            expiration_time: 'PT31M',
          },
        ],
      },
    });
    // A URL do webhook fica no painel do Mercado Pago, não na order.
    expect(String(init?.body)).not.toContain('notification_url');
  });

  it('manda o valor em texto com dois decimais, sem ponto flutuante', async () => {
    for (const [amountCents, text] of [
      [5000, '50.00'],
      [1, '0.01'],
      [10, '0.10'],
      [123456789, '1234567.89'],
    ] as const) {
      const fetchFn = fakeFetch(() => json(created, 201));
      await new MercadoPagoClient(token, fetchFn)
        .createPixPayment({ ...input, amountCents })
        .catch(() => undefined);
      const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as {
        total_amount: string;
        transactions: { payments: { amount: string }[] };
      };
      expect(body.total_amount).toBe(text);
      expect(body.transactions.payments[0].amount).toBe(text);
    }
  });

  it('a mesma chave de idempotência vai em toda repetição da mesma tentativa', async () => {
    const fetchFn = fakeFetch(() => json(created, 201));
    const client = new MercadoPagoClient(token, fetchFn);
    await client.createPixPayment(input);
    await client.createPixPayment(input);
    const keys = fetchFn.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['X-Idempotency-Key'],
    );
    expect(keys).toEqual([input.idempotencyKey, input.idempotencyKey]);
  });

  it('order criada sem exatamente uma transação Pix com QR é falha do provedor', async () => {
    const [pix] = created.transactions.payments;
    const bodies = [
      { ...created, transactions: { payments: [] } },
      { ...created, transactions: { payments: [pix, pix] } },
      { ...created, transactions: undefined },
      {
        ...created,
        transactions: {
          payments: [{ ...pix, payment_method: { ...pix.payment_method, id: 'visa' } }],
        },
      },
      {
        ...created,
        transactions: {
          payments: [{ ...pix, payment_method: { id: 'pix', type: 'bank_transfer' } }],
        },
      },
      { ...created, id: '5466310457' },
      { ...created, status: undefined },
      { ...created, total_amount: 259.8 },
      'ok',
    ];
    for (const body of bodies) {
      const client = new MercadoPagoClient(
        token,
        fakeFetch(() => json(body, 201)),
      );
      await expect(client.createPixPayment(input)).rejects.toBeInstanceOf(PixProviderError);
    }
  });

  it('consulta a order e converte valor, valor pago, moeda e última atualização', async () => {
    const fetchFn = fakeFetch(() =>
      json({
        ...created,
        status: 'processed',
        status_detail: 'accredited',
        total_paid_amount: '259.80',
        currency_id: 'BRL',
        last_updated_date: '2026-10-28T09:10:05.123456789-03:00',
      }),
    );
    const payment = await new MercadoPagoClient(token, fetchFn).getPayment(mpOrderId);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`https://api.mercadopago.com/v1/orders/${mpOrderId}`);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(init?.body).toBeUndefined();
    expect(payment).toEqual({
      id: mpOrderId,
      status: 'processed',
      statusDetail: 'accredited',
      externalReference: orderId,
      amountCents: 25980,
      paidAmountCents: 25980,
      currency: 'BRL',
      dateLastUpdated: new Date('2026-10-28T12:10:05.123Z'),
    });
  });

  it('moeda: currency_id ou currency quando vier; senão BRL só se o país for BRA', async () => {
    const cases = [
      [{ currency_id: 'USD' }, 'USD'],
      [{ currency: 'BRL', country_code: undefined }, 'BRL'],
      [{ country_code: 'ARG' }, null],
      [{ country_code: undefined }, null],
    ] as const;
    for (const [over, currency] of cases) {
      const client = new MercadoPagoClient(
        token,
        fakeFetch(() => json({ ...created, ...over })),
      );
      expect((await client.getPayment(mpOrderId)).currency).toBe(currency);
    }
  });

  it('total_amount em texto vira centavos exatos; formato inválido é falha do provedor', async () => {
    for (const [text, cents] of [
      ['50.00', 5000],
      ['50', 5000],
      ['0.1', 10],
      ['259.80', 25980],
      ['0.29', 29],
    ] as const) {
      const client = new MercadoPagoClient(
        token,
        fakeFetch(() => json({ ...created, total_amount: text })),
      );
      expect((await client.getPayment(mpOrderId)).amountCents).toBe(cents);
    }
    for (const text of ['259.805', '1e3', '-5.00', '50,00', '', ' 50.00', 259.8]) {
      const client = new MercadoPagoClient(
        token,
        fakeFetch(() => json({ ...created, total_amount: text })),
      );
      await expect(client.getPayment(mpOrderId)).rejects.toBeInstanceOf(PixProviderError);
    }
  });

  it('consulta que devolve outra order ou resposta fora do schema é falha do provedor', async () => {
    for (const body of [
      { ...created, id: 'ORD01JP84C939T20S0P1DN382FQ6Z' },
      { ...created, last_updated_date: 'ontem' },
      { ...created, status: '' },
    ]) {
      const client = new MercadoPagoClient(
        token,
        fakeFetch(() => json(body)),
      );
      await expect(client.getPayment(mpOrderId)).rejects.toBeInstanceOf(PixProviderError);
    }
  });

  it('cancela com POST /cancel, sem corpo, com chave de idempotência da order', async () => {
    const fetchFn = fakeFetch(() =>
      json({
        ...created,
        status: 'canceled',
        status_detail: 'canceled',
        last_updated_date: '2026-10-28T12:31:00.000Z',
      }),
    );
    const client = new MercadoPagoClient(token, fetchFn);
    const payment = await client.cancelPayment(mpOrderId);
    await client.cancelPayment(mpOrderId);

    expect(payment).toMatchObject({
      id: mpOrderId,
      status: 'canceled',
      statusDetail: 'canceled',
      dateLastUpdated: new Date('2026-10-28T12:31:00.000Z'),
    });
    expect(JSON.stringify(payment)).not.toContain('ana@example.com');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`https://api.mercadopago.com/v1/orders/${mpOrderId}/cancel`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `otilc-pix-cancel-${mpOrderId}`,
    });
    // Repetir o cancelamento da mesma order usa a mesma chave.
    expect(fetchFn.mock.calls[1][1]?.headers).toMatchObject({
      'X-Idempotency-Key': `otilc-pix-cancel-${mpOrderId}`,
    });
  });

  it('cancelamento recusado com 4xx de "não cancelável" sinaliza notCancellable', async () => {
    for (const [status, code] of [
      [409, 'order_already_canceled'],
      [400, 'invalid_order_status'],
      [422, 'order_cannot_be_canceled'],
    ] as const) {
      const client = new MercadoPagoClient(
        token,
        fakeFetch(() => json({ errors: [{ code, message: 'Order cannot be canceled.' }] }, status)),
      );
      const err = await client.cancelPayment(mpOrderId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PixProviderError);
      expect((err as PixProviderError).notCancellable).toBe(true);
    }
  });

  it('cancelamento: rede, 5xx, acesso, 404, 429 e resposta fora do schema são falha comum', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const failures = [
      () => json({ ...created, status: undefined }),
      () => json({ ...created, id: 'ORD01JP84C939T20S0P1DN382FQ6Z' }),
      () => json({ errors: [{ code: 'internal_error' }] }, 500),
      () => json({ errors: [{ code: 'unauthorized' }] }, 401),
      () => json({ errors: [{ code: 'order_not_found' }] }, 404),
      () => json({ errors: [{ code: 'too_many_requests' }] }, 429),
      () => Promise.reject(timeout),
    ];
    for (const failure of failures) {
      const client = new MercadoPagoClient(token, fakeFetch(failure));
      const err = await client.cancelPayment(mpOrderId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PixProviderError);
      expect((err as PixProviderError).notCancellable).toBe(false);
      expect((err as Error).message).not.toContain(token);
    }
  });

  it('id que não é de order nem chega ao provedor', async () => {
    const fetchFn = fakeFetch(() => json(created));
    const client = new MercadoPagoClient(token, fetchFn);
    for (const id of ['5466310457', '../users', `${mpOrderId}/cancel`, mpOrderId.toLowerCase()]) {
      await expect(client.getPayment(id)).rejects.toBeInstanceOf(PixProviderError);
      await expect(client.cancelPayment(id)).rejects.toBeInstanceOf(PixProviderError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('erro HTTP, 429, rede, tempo esgotado e corpo não JSON viram falha sem vazar token nem corpo', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const failures = [
      () => json({ message: 'invalid token', payer: 'ana@example.com' }, 401),
      () => json({ errors: [{ code: 'internal_error', message: 'boom' }] }, 500),
      () => json({ errors: [{ code: 'too_many_requests' }] }, 429),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(timeout),
      () => new Response('<html>', { status: 200 }),
    ];
    for (const failure of failures) {
      const client = new MercadoPagoClient(token, fakeFetch(failure));
      const err = await client.getPayment(mpOrderId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PixProviderError);
      expect((err as Error).message).not.toContain(token);
      expect((err as Error).message).not.toContain('ana@example.com');
    }
  });

  it('erro do Mercado Pago vai para o log com método, rota sem id, status e código, sem dados do pagador', async () => {
    const client = new MercadoPagoClient(
      token,
      fakeFetch(() =>
        json(
          {
            errors: [
              {
                code: 'property_value',
                message: `invalid payer ana@example.com (Ana)\nfirst_name ${'x'.repeat(300)}`,
                details: ['payer.email: ana@example.com'],
              },
            ],
          },
          400,
        ),
      ),
    );
    await expect(client.createPixPayment(input)).rejects.toThrow(/400 \(property_value\)/);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/^Mercado Pago POST \/v1\/orders respondeu 400 \(property_value\): /);
    expect(line).not.toContain('ana@example.com');
    expect(line).not.toContain('Ana');
    expect(line).not.toContain(token);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(220);

    warn.mockClear();
    const get = new MercadoPagoClient(
      token,
      fakeFetch(() => json({ errors: [{ code: 'order_not_found' }] }, 404)),
    );
    await get.getPayment(mpOrderId).catch(() => undefined);
    const getLine = String(warn.mock.calls[0][0]);
    expect(getLine).toBe('Mercado Pago GET /v1/orders/{id} respondeu 404 (order_not_found)');
    expect(getLine).not.toContain(mpOrderId);

    warn.mockClear();
    const odd = new MercadoPagoClient(
      token,
      fakeFetch(() => new Response('<html>erro</html>', { status: 502 })),
    );
    await odd.cancelPayment(mpOrderId).catch(() => undefined);
    expect(String(warn.mock.calls[0][0])).toBe(
      'Mercado Pago POST /v1/orders/{id}/cancel respondeu 502',
    );
  });
});

describe('isOrderId', () => {
  it('aceita só id de order', () => {
    expect(isOrderId(mpOrderId)).toBe(true);
    for (const id of ['5466310457', 'PAY01JP84C939T20S0P1DN382FQ6K', '', `${mpOrderId}?x=1`]) {
      expect(isOrderId(id)).toBe(false);
    }
  });
});

describe('toChargeStatus e isReversal', () => {
  // [status, status_detail, cobrança, desfaz um pagamento aprovado]
  const table = [
    ['created', 'created', 'PENDING', false],
    ['action_required', 'waiting_transfer', 'PENDING', false],
    ['action_required', 'waiting_payment', 'PENDING', false],
    ['action_required', 'waiting_capture', 'PENDING', false],
    ['action_required', 'waiting_retry', 'PENDING', false],
    ['processing', 'in_process', 'PENDING', false],
    ['processed', 'accredited', 'APPROVED', false],
    ['processed', 'partially_refunded', 'APPROVED', true],
    ['processed', null, null, false],
    ['refunded', 'refunded', 'REFUNDED', true],
    ['charged_back', 'in_process', null, true],
    ['charged_back', 'settled', null, true],
    ['charged_back', 'reimbursed', null, true],
    ['canceled', 'canceled', 'CANCELLED', false],
    ['canceled', 'expired', 'CANCELLED', false],
    ['failed', 'expired', 'CANCELLED', false],
    ['failed', 'failed', 'REJECTED', false],
    ['failed', null, null, false],
    // A API de Pagamentos escrevia `cancelled` (dois L) e `approved`: aqui são desconhecidos.
    ['cancelled', 'cancelled', null, false],
    ['approved', 'accredited', null, false],
    ['PROCESSED', 'accredited', null, false],
  ] as const;

  it.each(table)('%s/%s → %s (estorno: %s)', (status, detail, charge, reversal) => {
    expect(toChargeStatus(status, detail)).toBe(charge);
    expect(isReversal(status, detail)).toBe(reversal);
  });
});
