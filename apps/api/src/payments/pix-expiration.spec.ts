import { PIX_MIN_VALIDITY_MINUTES, pixExpiresAt } from './pix-expiration';

describe('pixExpiresAt', () => {
  const now = new Date('2026-10-28T12:00:00.000Z');

  it('respeita a validade mínima de 30 minutos do Mercado Pago, com folga', () => {
    const minutes = (pixExpiresAt(now).getTime() - now.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(PIX_MIN_VALIDITY_MINUTES);
    expect(minutes).toBeLessThanOrEqual(PIX_MIN_VALIDITY_MINUTES + 5);
  });

  it('conta a partir da criação da cobrança, não do pedido', () => {
    expect(pixExpiresAt(now).toISOString()).toBe('2026-10-28T12:31:00.000Z');
  });
});
