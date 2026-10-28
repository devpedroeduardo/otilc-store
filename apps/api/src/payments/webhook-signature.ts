import { createHmac, timingSafeEqual } from 'node:crypto';

/** Diferença máxima entre o `ts` da assinatura e o relógio do servidor. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

/** `x-request-id` aceito: o Mercado Pago envia um UUID. Fica gravado como chave de idempotência. */
const REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/;
/** `ts` em segundos (até 11 dígitos) ou em milissegundos (13 dígitos); outro tamanho é recusado. */
const TS = /^(\d{1,11}|\d{13})$/;
const V1 = /^[0-9a-f]{64}$/i;

export interface SignatureInput {
  /** Header `x-signature`: `ts=<segundos ou milissegundos>,v1=<hmac hex>`. */
  signature: unknown;
  /** Header `x-request-id`. */
  requestId: unknown;
  /** `data.id` da query string, já validado. */
  dataId: string;
  secret: string;
  now?: number;
}

/**
 * Confere a assinatura do webhook do Mercado Pago.
 *
 * Texto assinado com HMAC-SHA256 e o segredo do webhook (SDK oficial, sdk-nodejs
 * `src/utils/webhook`): `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, com o `ts` cru, como
 * veio no header. A documentação oficial traz exemplos em milissegundos (13 dígitos) e em segundos
 * (10 dígitos): os dois são aceitos, e a janela de 5 minutos usa o valor convertido.
 * A versão antiga da documentação pedia `data.id` alfanumérico em minúsculas e o SDK atual usa o
 * valor cru: as duas formas são aceitas, ambas exigem o segredo. Ids de pagamento são numéricos.
 * Header ausente ou repetido, formato inválido, assinatura diferente ou `ts` fora da janela de
 * 5 minutos → `false`. A comparação é em tempo constante, com o tamanho conferido antes.
 */
export function verifyWebhookSignature(input: SignatureInput): boolean {
  const { signature, requestId, dataId, secret, now = Date.now() } = input;
  if (typeof signature !== 'string' || typeof requestId !== 'string') return false;
  if (!REQUEST_ID.test(requestId)) return false;

  const parts = parseSignature(signature);
  if (!parts) return false;
  const { ts, v1 } = parts;
  const tsMs = ts.length === 13 ? Number(ts) : Number(ts) * 1000;
  if (Math.abs(now - tsMs) > SIGNATURE_TOLERANCE_MS) return false;

  const expected = Buffer.from(v1, 'hex');
  const candidates = new Set([dataId, dataId.toLowerCase()]);
  let valid = false;
  for (const id of candidates) {
    const computed = createHmac('sha256', secret)
      .update(`id:${id};request-id:${requestId};ts:${ts};`)
      .digest();
    // Sem atalho: as duas formas são sempre calculadas e comparadas.
    if (computed.length === expected.length && timingSafeEqual(computed, expected)) valid = true;
  }
  return valid;
}

/** `ts=...,v1=...` em qualquer ordem, com espaços opcionais. Chave repetida invalida o header. */
function parseSignature(header: string): { ts: string; v1: string } | null {
  if (header.length > 300) return null;
  const fields = new Map<string, string>();
  for (const pair of header.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    if (fields.has(key)) return null;
    fields.set(key, pair.slice(eq + 1).trim());
  }
  const ts = fields.get('ts');
  const v1 = fields.get('v1');
  if (!ts || !v1 || !TS.test(ts) || !V1.test(v1)) return null;
  return { ts, v1 };
}
