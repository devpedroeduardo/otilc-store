import { randomBytes } from 'node:crypto';
import { loadEnv, pixConfig } from './env';

const DATABASE_URL = 'postgres://u@localhost:5432/db';
// Valores gerados na hora: nenhum segredo real no teste.
const pix = {
  MP_ACCESS_TOKEN: `TEST-${randomBytes(16).toString('hex')}`,
  MP_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  MP_NOTIFICATION_URL: 'https://api.example.test/api/webhooks/mercadopago',
};

describe('loadEnv', () => {
  it('aplica valores padrão', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env.PORT).toBe(3333);
    expect(env.ORDER_HOLD_MINUTES).toBe(30);
  });

  it('não sobe sem DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('fora de produção, Pix fica desligado se faltar qualquer variável do Mercado Pago', () => {
    expect(pixConfig(loadEnv({ DATABASE_URL }))).toBeNull();
    for (const key of Object.keys(pix) as (keyof typeof pix)[]) {
      const partial = { DATABASE_URL, ...pix, [key]: '' };
      expect(pixConfig(loadEnv(partial))).toBeNull();
    }
  });

  it('com as três variáveis, o Pix fica ligado', () => {
    expect(pixConfig(loadEnv({ DATABASE_URL, NODE_ENV: 'test', ...pix }))).toEqual({
      accessToken: pix.MP_ACCESS_TOKEN,
      webhookSecret: pix.MP_WEBHOOK_SECRET,
      notificationUrl: pix.MP_NOTIFICATION_URL,
    });
  });

  it('em produção, não sobe sem as variáveis do Mercado Pago', () => {
    expect(() => loadEnv({ DATABASE_URL, NODE_ENV: 'production' })).toThrow(
      /MP_ACCESS_TOKEN.*MP_WEBHOOK_SECRET.*MP_NOTIFICATION_URL/,
    );
    expect(() =>
      loadEnv({ DATABASE_URL, NODE_ENV: 'production', ...pix, MP_WEBHOOK_SECRET: '' }),
    ).toThrow(/MP_WEBHOOK_SECRET/);
    expect(loadEnv({ DATABASE_URL, NODE_ENV: 'production', ...pix }).MP_ACCESS_TOKEN).toBe(
      pix.MP_ACCESS_TOKEN,
    );
  });

  it('URL de notificação precisa ser https', () => {
    expect(() =>
      loadEnv({ DATABASE_URL, ...pix, MP_NOTIFICATION_URL: 'http://api.example.test/webhook' }),
    ).toThrow(/MP_NOTIFICATION_URL/);
  });

  it('a mensagem de erro nunca traz o valor das variáveis', () => {
    const token = 'x'.repeat(501);
    try {
      loadEnv({ DATABASE_URL, ...pix, MP_ACCESS_TOKEN: token });
      throw new Error('deveria falhar');
    } catch (err) {
      expect((err as Error).message).toMatch(/MP_ACCESS_TOKEN/);
      expect((err as Error).message).not.toContain(token);
      expect((err as Error).message).not.toContain(pix.MP_WEBHOOK_SECRET);
    }
  });
});
