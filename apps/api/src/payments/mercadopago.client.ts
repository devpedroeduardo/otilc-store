import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { mercadoPagoOrderIdSchema, type PixChargeStatus } from '@otilc/shared';

/**
 * Order do Mercado Pago (API de Orders, spec-021) como a loja precisa dela, já validada. Nunca
 * inclui dados do pagador.
 */
export interface ProviderPayment {
  /** Id da order (`ORD…`), o mesmo de `payments.provider_payment_id`. */
  id: string;
  /** Status da order (`action_required`, `processed`...). Ver `toChargeStatus`. */
  status: string;
  /** Detalhe do status da order (`waiting_transfer`, `accredited`...), quando vier. */
  statusDetail: string | null;
  externalReference: string | null;
  /** `total_amount` em centavos. */
  amountCents: number;
  /** `total_paid_amount` em centavos, quando vier. */
  paidAmountCents: number | null;
  /** Moeda da order (`BRL`), ou `null` se ela não disser. */
  currency: string | null;
  /**
   * `last_updated_date` da order. A referência do `GET /v1/orders/{id}` não traz data de
   * aprovação: na primeira vez que a order aparece aprovada, esta é a data usada (spec-021).
   */
  dateLastUpdated: Date | null;
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
  /** Primeiro nome do cliente (no sandbox, `APRO` aprova o Pix sozinho). */
  payerFirstName: string;
  /** Validade do Pix como duração ISO 8601 (ex.: `PT31M`). */
  expirationTime: string;
  idempotencyKey: string;
}

/**
 * As chamadas do Mercado Pago que a loja usa, todas sobre a order do Pix. Os nomes vêm da API de
 * Pagamentos (spec-014) e ficaram para não espalhar a troca de provedor pelo resto do código.
 * Os testes injetam um cliente simulado.
 */
export interface PixProvider {
  createPixPayment(input: CreatePixInput): Promise<CreatedPixPayment>;
  getPayment(id: string): Promise<ProviderPayment>;
  /**
   * Cancela a order do Pix ainda não pago e devolve como ela ficou no Mercado Pago. Se ela não
   * pode mais ser cancelada (já cancelada ou já paga), lança `PixProviderError` com
   * `notCancellable`: quem chama consulta a order para saber o estado real.
   */
  cancelPayment(id: string): Promise<ProviderPayment>;
}

export const PIX_PROVIDER = Symbol('PIX_PROVIDER');

/**
 * Falha do provedor: rede, tempo esgotado, status HTTP de erro ou resposta fora do schema.
 * A mensagem nunca traz o corpo da resposta (pode ter e-mail do pagador ou QR code).
 */
export class PixProviderError extends Error {
  override readonly name = 'PixProviderError';
  /** O cancelamento foi recusado porque a order não está mais cancelável (4xx do Mercado Pago). */
  readonly notCancellable: boolean;

  constructor(message: string, options: { notCancellable?: boolean } = {}) {
    super(message);
    this.notCancellable = options.notCancellable ?? false;
  }
}

/** Status HTTP de erro do Mercado Pago, guardado para o cancelamento decidir. */
class MercadoPagoHttpError extends PixProviderError {
  constructor(
    readonly httpStatus: number,
    code: string | null,
  ) {
    super(`Mercado Pago respondeu ${httpStatus}${code ? ` (${code})` : ''}.`);
  }
}

const MP_API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10_000;

/** Id de order válido: a checagem vem antes de qualquer chamada ao Mercado Pago. */
export function isOrderId(id: string): boolean {
  return mercadoPagoOrderIdSchema.safeParse(id).success;
}

/**
 * Mapeia o status da order (e o detalhe) para o status da cobrança. Desconhecido → `null`: não
 * muda nada (só log). `charged_back` também é `null`: numa cobrança aprovada ele só gera alerta
 * (`isReversal`), e numa pendente não paga o pedido.
 */
export function toChargeStatus(
  status: string,
  statusDetail: string | null,
): PixChargeStatus | null {
  switch (status) {
    case 'created':
    case 'action_required':
    case 'processing':
      return 'PENDING';
    case 'processed':
      return statusDetail === 'accredited' || statusDetail === 'partially_refunded'
        ? 'APPROVED'
        : null;
    case 'refunded':
      return 'REFUNDED';
    case 'canceled':
      return 'CANCELLED';
    case 'failed':
      if (statusDetail === 'expired') return 'CANCELLED';
      if (statusDetail === 'failed') return 'REJECTED';
      return null;
    default:
      return null;
  }
}

/** Status que desfazem, no todo ou em parte, um pagamento aprovado (estorno ou contestação). */
export function isReversal(status: string, statusDetail: string | null): boolean {
  return (
    status === 'refunded' ||
    status === 'charged_back' ||
    (status === 'processed' && statusDetail === 'partially_refunded')
  );
}

/** Valor em texto (`"50.00"`) para centavos, sem passar por número de ponto flutuante. */
const amountSchema = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,2})?$/)
  .transform((value) => {
    const [reais, fraction = ''] = value.split('.');
    return Number(reais) * 100 + Number(fraction.padEnd(2, '0'));
  });

const orderSchema = z.object({
  id: mercadoPagoOrderIdSchema,
  status: z.string().min(1).max(40),
  status_detail: z.string().max(60).nullish(),
  external_reference: z.string().max(256).nullish(),
  total_amount: amountSchema,
  total_paid_amount: amountSchema.nullish(),
  // A doc mostra a moeda como `currency_id` ou `currency`; sem nenhuma, vale o país.
  currency_id: z.string().max(10).nullish(),
  currency: z.string().max(10).nullish(),
  country_code: z.string().max(10).nullish(),
  last_updated_date: z.iso.datetime({ offset: true }).nullish(),
});

/** A order criada precisa ter exatamente uma transação, Pix, com o QR code. */
const createdOrderSchema = orderSchema.extend({
  transactions: z.object({
    payments: z
      .array(
        z.object({
          payment_method: z.object({
            id: z.literal('pix'),
            qr_code: z.string().min(1).max(2000),
            qr_code_base64: z.base64().min(1).max(200_000),
          }),
        }),
      )
      .length(1),
  }),
});

function toProviderPayment(o: z.infer<typeof orderSchema>): ProviderPayment {
  const currency = o.currency_id ?? o.currency ?? (o.country_code === 'BRA' ? 'BRL' : null);
  return {
    id: o.id,
    status: o.status,
    statusDetail: o.status_detail ?? null,
    externalReference: o.external_reference ?? null,
    amountCents: o.total_amount,
    paidAmountCents: o.total_paid_amount ?? null,
    currency,
    dateLastUpdated: o.last_updated_date ? new Date(o.last_updated_date) : null,
  };
}

/** Corpo de erro do Mercado Pago: só código e mensagem são lidos, para o log de diagnóstico. */
const errorBodySchema = z.object({
  errors: z
    .array(z.object({ code: z.unknown().optional(), message: z.unknown().optional() }))
    .min(1)
    .optional()
    .catch(undefined),
  error: z.unknown().optional(),
  code: z.unknown().optional(),
  message: z.unknown().optional(),
});

const MAX_ERROR_MESSAGE = 120;

/**
 * Código e mensagem do erro, prontos para o log: código só se for um identificador; mensagem numa
 * linha, truncada, sem e-mail nem os textos de `redact` (e-mail e nome do pagador).
 */
function errorDetail(body: unknown, redact: string[]): { code: string | null; message: string } {
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) return { code: null, message: '' };
  const first = parsed.data.errors?.[0];
  const rawCode = first?.code ?? parsed.data.code ?? parsed.data.error;
  const code =
    typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : null;
  const rawMessage = first?.message ?? parsed.data.message;
  if (typeof rawMessage !== 'string') return { code, message: '' };
  let message = rawMessage.replace(/[^\s@]+@[^\s@]+/g, '[e-mail]');
  for (const text of redact) {
    if (text.length >= 2) message = message.split(text).join('[pagador]');
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > MAX_ERROR_MESSAGE) message = `${message.slice(0, MAX_ERROR_MESSAGE)}…`;
  return { code, message };
}

/**
 * 4xx do cancelamento que quer dizer "a order não está mais cancelável" (ex.:
 * `order_already_canceled`, ou já `processed`). Acesso negado, id inexistente, tempo esgotado e
 * limite de requisições são falhas comuns.
 */
function isNotCancellableStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status);
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  /** Rota sem o id, para o log. */
  route: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Textos do pagador que nunca podem ir para o log. */
  redact?: string[];
}

/**
 * Cliente do Mercado Pago (API de Orders) com `fetch` nativo, sem SDK. Respostas validadas com
 * Zod; o que não passar no schema é falha do provedor. Timeout explícito em cada chamada e sem
 * retry: a criação repetida pelo cliente usa a mesma chave de idempotência.
 */
export class MercadoPagoClient implements PixProvider {
  private readonly logger = new Logger(MercadoPagoClient.name);

  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async createPixPayment(input: CreatePixInput): Promise<CreatedPixPayment> {
    const amount = toAmount(input.amountCents);
    const body = {
      type: 'online',
      processing_mode: 'automatic',
      external_reference: input.orderId,
      description: `Pedido OTILC #${input.orderNumber}`,
      total_amount: amount,
      payer: { email: input.payerEmail, first_name: input.payerFirstName },
      transactions: {
        payments: [
          {
            amount,
            payment_method: { id: 'pix', type: 'bank_transfer' },
            expiration_time: input.expirationTime,
          },
        ],
      },
    };
    const json = await this.request({
      method: 'POST',
      path: '/v1/orders',
      route: '/v1/orders',
      headers: { 'X-Idempotency-Key': input.idempotencyKey },
      body,
      redact: [input.payerEmail, input.payerFirstName],
    });
    const parsed = createdOrderSchema.safeParse(json);
    if (!parsed.success) throw new PixProviderError('Resposta inesperada ao criar o Pix.');
    const { qr_code, qr_code_base64 } = parsed.data.transactions.payments[0].payment_method;
    return { ...toProviderPayment(parsed.data), qrCode: qr_code, qrCodeBase64: qr_code_base64 };
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    if (!isOrderId(id)) throw new PixProviderError('Id de order inválido.');
    const json = await this.request({
      method: 'GET',
      path: `/v1/orders/${id}`,
      route: '/v1/orders/{id}',
    });
    return this.parseOrder(json, id, 'Resposta inesperada ao consultar o Pix.');
  }

  async cancelPayment(id: string): Promise<ProviderPayment> {
    if (!isOrderId(id)) throw new PixProviderError('Id de order inválido.');
    let json: unknown;
    try {
      json = await this.request({
        method: 'POST',
        path: `/v1/orders/${id}/cancel`,
        route: '/v1/orders/{id}/cancel',
        // Uma chave por order: repetir o cancelamento da mesma order é o mesmo pedido.
        headers: { 'X-Idempotency-Key': `otilc-pix-cancel-${id}` },
      });
    } catch (err) {
      if (err instanceof MercadoPagoHttpError && isNotCancellableStatus(err.httpStatus)) {
        throw new PixProviderError(err.message, { notCancellable: true });
      }
      throw err;
    }
    return this.parseOrder(json, id, 'Resposta inesperada ao cancelar o Pix.');
  }

  private parseOrder(json: unknown, id: string, message: string): ProviderPayment {
    const parsed = orderSchema.safeParse(json);
    if (!parsed.success) throw new PixProviderError(message);
    if (parsed.data.id !== id) throw new PixProviderError('O provedor devolveu outra order.');
    return toProviderPayment(parsed.data);
  }

  private async request(options: RequestOptions): Promise<unknown> {
    const { method, path, route, body } = options;
    const headers: Record<string, string> = {
      ...options.headers,
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchFn(`${MP_API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError' ? 'tempo esgotado' : 'rede';
      throw new PixProviderError(`Mercado Pago indisponível (${reason}).`);
    }
    if (!res.ok) {
      // Diagnóstico (achado 2 da spec-017): método, rota sem id, status, código e mensagem do
      // Mercado Pago. Nunca o token, o corpo inteiro nem dados do pagador.
      const errorBody: unknown = await res.json().catch(() => null);
      const { code, message } = errorDetail(errorBody, options.redact ?? []);
      this.logger.warn(
        `Mercado Pago ${method} ${route} respondeu ${res.status}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`,
      );
      throw new MercadoPagoHttpError(res.status, code);
    }
    try {
      return await res.json();
    } catch {
      throw new PixProviderError('Resposta do Mercado Pago não é JSON.');
    }
  }
}

/** Centavos inteiros para o texto que a API de Orders espera (`25980` → `"259.80"`). */
function toAmount(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
