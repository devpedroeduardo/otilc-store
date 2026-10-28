import { randomBytes } from 'node:crypto';
import { MercadoPagoClient, PixProviderError, toChargeStatus } from './mercadopago.client';

// Token gerado na hora: nenhum valor real no teste.
const token = `TEST-${randomBytes(16).toString('hex')}`;
const orderId = '3b241101-e2bb-4255-8caf-4136c566a962';
const qrCodeBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const created = {
  id: 5466310457,
  status: 'pending',
  status_detail: 'pending_waiting_transfer',
  external_reference: orderId,
  transaction_amount: 259.8,
  currency_id: 'BRL',
  date_approved: null,
  payer: { email: 'ana@example.com' },
  point_of_interaction: {
    transaction_data: {
      qr_code: '00020126580014br.gov.bcb.pix-ficticio',
      qr_code_base64: qrCodeBase64,
    },
  },
};

const input = {
  orderId,
  orderNumber: 42,
  amountCents: 25980,
  payerEmail: 'ana@example.com',
  expiresAt: new Date('2026-10-28T12:31:00.000Z'),
  notificationUrl: 'https://api.example.test/api/webhooks/mercadopago',
  idempotencyKey: `otilc-pix-${orderId}-1`,
};

function fakeFetch(response: () => Promise<Response> | Response) {
  return jest.fn(async (..._args: Parameters<typeof fetch>) => response());
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('MercadoPagoClient', () => {
  it('cria o Pix com valor do pedido, referência, validade, notificação e chave de idempotência', async () => {
    const fetchFn = fakeFetch(() => json(created, 201));
    const client = new MercadoPagoClient(token, fetchFn);

    const payment = await client.createPixPayment(input);

    expect(payment).toEqual({
      id: '5466310457',
      status: 'pending',
      externalReference: orderId,
      amountCents: 25980,
      currency: 'BRL',
      dateApproved: null,
      qrCode: created.point_of_interaction.transaction_data.qr_code,
      qrCodeBase64,
    });
    // Nada do pagador sai do cliente.
    expect(JSON.stringify(payment)).not.toContain('ana@example.com');

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.mercadopago.com/v1/payments');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      'X-Idempotency-Key': input.idempotencyKey,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      transaction_amount: 259.8,
      payment_method_id: 'pix',
      description: 'Pedido OTILC #42',
      external_reference: orderId,
      notification_url: input.notificationUrl,
      date_of_expiration: '2026-10-28T12:31:00.000+00:00',
      payer: { email: 'ana@example.com' },
    });
  });

  it('consulta o pagamento e converte valor e data de aprovação', async () => {
    const fetchFn = fakeFetch(() =>
      json({
        ...created,
        status: 'approved',
        transaction_amount: '259.80',
        date_approved: '2026-10-28T09:10:00.000-03:00',
      }),
    );
    const payment = await new MercadoPagoClient(token, fetchFn).getPayment('5466310457');

    expect(fetchFn.mock.calls[0][0]).toBe('https://api.mercadopago.com/v1/payments/5466310457');
    expect(payment).toMatchObject({
      status: 'approved',
      amountCents: 25980,
      dateApproved: new Date('2026-10-28T12:10:00.000Z'),
    });
  });

  it('valor fora de centavos inteiros vira amountCents nulo (nunca igual ao total)', async () => {
    const fetchFn = fakeFetch(() => json({ ...created, transaction_amount: 259.805 }));
    const payment = await new MercadoPagoClient(token, fetchFn).getPayment('5466310457');
    expect(payment.amountCents).toBeNull();
  });

  it('resposta fora do schema é falha do provedor', async () => {
    const noQr = { ...created, point_of_interaction: {} };
    for (const body of [noQr, { ...created, id: 'abc' }, { ...created, status: undefined }, 'ok']) {
      const client = new MercadoPagoClient(
        token,
        fakeFetch(() => json(body)),
      );
      await expect(client.createPixPayment(input)).rejects.toBeInstanceOf(PixProviderError);
    }
  });

  it('consulta que devolve outro pagamento é falha do provedor', async () => {
    const client = new MercadoPagoClient(
      token,
      fakeFetch(() => json({ ...created, id: 1 })),
    );
    await expect(client.getPayment('5466310457')).rejects.toBeInstanceOf(PixProviderError);
  });

  it('id que não é numérico nem chega ao provedor', async () => {
    const fetchFn = fakeFetch(() => json(created));
    await expect(
      new MercadoPagoClient(token, fetchFn).getPayment('../users'),
    ).rejects.toBeInstanceOf(PixProviderError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('erro HTTP, rede, tempo esgotado e corpo não JSON viram falha sem vazar token nem corpo', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const failures = [
      () => json({ message: 'invalid token', payer: 'ana@example.com' }, 401),
      () => json({ message: 'boom' }, 500),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(timeout),
      () => new Response('<html>', { status: 200 }),
    ];
    for (const failure of failures) {
      const client = new MercadoPagoClient(token, fakeFetch(failure));
      const err = await client.getPayment('1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PixProviderError);
      expect((err as Error).message).not.toContain(token);
      expect((err as Error).message).not.toContain('ana@example.com');
    }
  });
});

describe('toChargeStatus', () => {
  it('mapeia os status do Mercado Pago e devolve null para desconhecido', () => {
    expect(toChargeStatus('pending')).toBe('PENDING');
    expect(toChargeStatus('in_process')).toBe('PENDING');
    expect(toChargeStatus('approved')).toBe('APPROVED');
    expect(toChargeStatus('rejected')).toBe('REJECTED');
    expect(toChargeStatus('cancelled')).toBe('CANCELLED');
    expect(toChargeStatus('refunded')).toBe('REFUNDED');
    expect(toChargeStatus('charged_back')).toBeNull();
    expect(toChargeStatus('in_mediation')).toBeNull();
    expect(toChargeStatus('APPROVED')).toBeNull();
  });
});
