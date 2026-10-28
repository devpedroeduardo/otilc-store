import { z } from 'zod';
import type { PixChargeStatus } from '@otilc/shared';

/** Pagamento como a loja precisa dele, já validado. Nunca inclui dados do pagador. */
export interface ProviderPayment {
  id: string;
  /** Status cru do Mercado Pago (`approved`, `pending`...). Ver `toChargeStatus`. */
  status: string;
  externalReference: string | null;
  /** Valor em centavos, ou `null` se o valor não fecha em centavos inteiros. */
  amountCents: number | null;
  currency: string | null;
  dateApproved: Date | null;
}

export interface CreatedPixPayment extends ProviderPayment {
  qrCode: string;
  qrCodeBase64: string;
}

export interface CreatePixInput {
  orderId: string;
  orderNumber: number;
  amountCents: number;
  payerEmail: string;
  expiresAt: Date;
  notificationUrl: string;
  idempotencyKey: string;
}

/** As duas chamadas do Mercado Pago que a loja usa. Os testes injetam um cliente simulado. */
export interface PixProvider {
  createPixPayment(input: CreatePixInput): Promise<CreatedPixPayment>;
  getPayment(id: string): Promise<ProviderPayment>;
}

export const PIX_PROVIDER = Symbol('PIX_PROVIDER');

/**
 * Falha do provedor: rede, tempo esgotado, status HTTP de erro ou resposta fora do schema.
 * A mensagem nunca traz o corpo da resposta (pode ter e-mail do pagador ou QR code).
 */
export class PixProviderError extends Error {
  override readonly name = 'PixProviderError';
}

const MP_API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10_000;

/** Mapeia o status do Mercado Pago. Desconhecido → `null`: não muda nada (só log). */
export function toChargeStatus(status: string): PixChargeStatus | null {
  switch (status) {
    case 'pending':
    case 'in_process':
    case 'authorized':
      return 'PENDING';
    case 'approved':
      return 'APPROVED';
    case 'rejected':
      return 'REJECTED';
    case 'cancelled':
      return 'CANCELLED';
    case 'refunded':
      return 'REFUNDED';
    default:
      return null;
  }
}

/** Reais (número ou texto) para centavos, só se o valor fechar em centavos inteiros. */
function toCentsExact(reais: number): number | null {
  const cents = Math.round(reais * 100);
  return Math.abs(cents - reais * 100) < 1e-6 ? cents : null;
}

const paymentSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,30}$/)]).transform(String),
  status: z.string().min(1).max(40),
  external_reference: z.string().max(256).nullish(),
  transaction_amount: z
    .union([z.number(), z.string().regex(/^\d{1,9}(\.\d{1,10})?$/)])
    .transform(Number)
    .pipe(z.number().nonnegative().finite()),
  currency_id: z.string().max(10).nullish(),
  date_approved: z.iso.datetime({ offset: true }).nullish(),
});

const createdPaymentSchema = paymentSchema.extend({
  point_of_interaction: z.object({
    transaction_data: z.object({
      qr_code: z.string().min(1).max(2000),
      qr_code_base64: z.base64().min(1).max(200_000),
    }),
  }),
});

function toProviderPayment(p: z.infer<typeof paymentSchema>): ProviderPayment {
  return {
    id: p.id,
    status: p.status,
    externalReference: p.external_reference ?? null,
    amountCents: toCentsExact(p.transaction_amount),
    currency: p.currency_id ?? null,
    dateApproved: p.date_approved ? new Date(p.date_approved) : null,
  };
}

/**
 * Cliente do Mercado Pago com `fetch` nativo, sem SDK. Respostas validadas com Zod; o que não
 * passar no schema é falha do provedor. Timeout explícito em cada chamada.
 */
export class MercadoPagoClient implements PixProvider {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async createPixPayment(input: CreatePixInput): Promise<CreatedPixPayment> {
    const body = {
      transaction_amount: input.amountCents / 100,
      payment_method_id: 'pix',
      description: `Pedido OTILC #${input.orderNumber}`,
      external_reference: input.orderId,
      notification_url: input.notificationUrl,
      // Formato da doc: 2026-10-28T12:31:00.000+00:00 (com offset explícito).
      date_of_expiration: input.expiresAt.toISOString().replace('Z', '+00:00'),
      payer: { email: input.payerEmail },
    };
    const json = await this.request('/v1/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(body),
    });
    const parsed = createdPaymentSchema.safeParse(json);
    if (!parsed.success) throw new PixProviderError('Resposta inesperada ao criar o Pix.');
    const { qr_code, qr_code_base64 } = parsed.data.point_of_interaction.transaction_data;
    return { ...toProviderPayment(parsed.data), qrCode: qr_code, qrCodeBase64: qr_code_base64 };
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    if (!/^\d{1,30}$/.test(id)) throw new PixProviderError('Id de pagamento inválido.');
    const json = await this.request(`/v1/payments/${id}`, { method: 'GET' });
    const parsed = paymentSchema.safeParse(json);
    if (!parsed.success) throw new PixProviderError('Resposta inesperada ao consultar o Pix.');
    if (parsed.data.id !== id) throw new PixProviderError('O provedor devolveu outro pagamento.');
    return toProviderPayment(parsed.data);
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${MP_API}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError' ? 'tempo esgotado' : 'rede';
      throw new PixProviderError(`Mercado Pago indisponível (${reason}).`);
    }
    if (!res.ok) throw new PixProviderError(`Mercado Pago respondeu ${res.status}.`);
    try {
      return await res.json();
    } catch {
      throw new PixProviderError('Resposta do Mercado Pago não é JSON.');
    }
  }
}
