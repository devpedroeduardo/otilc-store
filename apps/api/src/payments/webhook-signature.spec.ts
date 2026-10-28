import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { SIGNATURE_TOLERANCE_MS, verifyWebhookSignature } from './webhook-signature';

// Segredo gerado na hora: nenhum valor real no teste.
const secret = randomBytes(32).toString('hex');
const now = Date.parse('2026-10-28T12:00:00.000Z');
const ts = String(Math.floor(now / 1000));
const requestId: string = randomUUID();
const dataId = '123456789';

function sign(manifest: string, key = secret) {
  return createHmac('sha256', key).update(manifest).digest('hex');
}
const manifest = (id = dataId, req = requestId, t = ts) => `id:${id};request-id:${req};ts:${t};`;
const header = (v1 = sign(manifest()), t = ts) => `ts=${t},v1=${v1}`;
const verify = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
  verifyWebhookSignature({ signature: header(), requestId, dataId, secret, now, ...over });

describe('verifyWebhookSignature', () => {
  it('aceita assinatura válida', () => {
    expect(verify()).toBe(true);
  });

  it('aceita campos em outra ordem, com espaços e hex maiúsculo', () => {
    const v1 = sign(manifest()).toUpperCase();
    expect(verify({ signature: ` v1=${v1} , ts=${ts} ` })).toBe(true);
  });

  it('aceita id alfanumérico assinado cru ou em minúsculas', () => {
    expect(verify({ dataId: 'AbC123', signature: header(sign(manifest('AbC123'))) })).toBe(true);
    expect(verify({ dataId: 'AbC123', signature: header(sign(manifest('abc123'))) })).toBe(true);
  });

  it('recusa assinatura com outro segredo', () => {
    expect(verify({ signature: header(sign(manifest(), randomBytes(32).toString('hex'))) })).toBe(
      false,
    );
  });

  it('recusa quando muda o id, o request-id ou o ts assinado', () => {
    expect(verify({ dataId: '123456780' })).toBe(false);
    expect(verify({ requestId: randomUUID() })).toBe(false);
    expect(verify({ signature: header(sign(manifest()), String(Number(ts) + 1)) })).toBe(false);
  });

  it('recusa assinatura de tamanho diferente sem lançar erro', () => {
    const v1 = sign(manifest());
    expect(verify({ signature: header(v1.slice(0, 62)) })).toBe(false);
    expect(verify({ signature: header(`${v1}00`) })).toBe(false);
    expect(verify({ signature: header('') })).toBe(false);
  });

  it('recusa header ausente, repetido ou malformado', () => {
    expect(verify({ signature: undefined })).toBe(false);
    expect(verify({ signature: [header(), header()] })).toBe(false);
    expect(verify({ signature: `${header()},v1=${sign(manifest())}` })).toBe(false);
    expect(verify({ signature: `v1=${sign(manifest())}` })).toBe(false);
    expect(verify({ signature: `ts=abc,v1=${sign(manifest())}` })).toBe(false);
    expect(verify({ signature: 'qualquer coisa' })).toBe(false);
  });

  it('recusa x-request-id ausente ou fora do formato', () => {
    expect(verify({ requestId: undefined })).toBe(false);
    const odd = 'id;ts:1';
    expect(verify({ requestId: odd, signature: header(sign(manifest(dataId, odd))) })).toBe(false);
  });

  it('aceita ts dentro da janela de 5 minutos e recusa fora dela, nos dois sentidos', () => {
    expect(verify({ now: now + SIGNATURE_TOLERANCE_MS })).toBe(true);
    expect(verify({ now: now - SIGNATURE_TOLERANCE_MS })).toBe(true);
    expect(verify({ now: now + SIGNATURE_TOLERANCE_MS + 1000 })).toBe(false);
    expect(verify({ now: now - SIGNATURE_TOLERANCE_MS - 1000 })).toBe(false);
  });

  it('trata ts como segundos: o mesmo instante em milissegundos fica fora da janela', () => {
    const ms = String(now);
    expect(verify({ signature: header(sign(manifest(dataId, requestId, ms)), ms) })).toBe(false);
  });
});
