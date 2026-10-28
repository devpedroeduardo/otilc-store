import { randomBytes } from 'node:crypto';
import { loadEnv, pixConfig } from './env';

const DATABASE_URL = 'postgres://u@localhost:5432/db';
// Valores gerados na hora: nenhum segredo real no teste.
const pix = {
  MP_ACCESS_TOKEN: `TEST-${randomBytes(16).toString('hex')}`,
  MP_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  MP_NOTIFICATION_URL: 'https://api.example.test/api/webhooks/mercadopago',
};
// O restante que a produção exige (spec-016). Certificado fictício, só com o formato PEM.
const CA_PEM = `-----BEGIN CERTIFICATE-----\n${randomBytes(48).toString('base64')}\n-----END CERTIFICATE-----\n`;
const prod = {
  DATABASE_URL,
  NODE_ENV: 'production',
  ...pix,
  WEB_ORIGIN: 'https://loja.example.test',
  DATABASE_CA_CERT: CA_PEM,
};

describe('loadEnv', () => {
  it('aplica valores padrão', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env.PORT).toBe(3333);
    expect(env.ORDER_HOLD_MINUTES).toBe(30);
    expect(env.PAYMENT_RECONCILIATION_INTERVAL_MS).toBe(300_000);
  });

  it('intervalo da conciliação: inteiro entre 30 s e 1 h', () => {
    expect(loadEnv({ DATABASE_URL, PAYMENT_RECONCILIATION_INTERVAL_MS: '60000' })).toMatchObject({
      PAYMENT_RECONCILIATION_INTERVAL_MS: 60_000,
    });
    for (const bad of ['0', '29999', '3600001', '60000.5', 'abc']) {
      expect(() => loadEnv({ DATABASE_URL, PAYMENT_RECONCILIATION_INTERVAL_MS: bad })).toThrow(
        /PAYMENT_RECONCILIATION_INTERVAL_MS/,
      );
    }
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
    expect(() => loadEnv({ ...prod, MP_WEBHOOK_SECRET: '' })).toThrow(/MP_WEBHOOK_SECRET/);
    expect(loadEnv(prod).MP_ACCESS_TOKEN).toBe(pix.MP_ACCESS_TOKEN);
  });

  it('em produção, não sobe sem DATABASE_CA_CERT', () => {
    expect(() => loadEnv({ ...prod, DATABASE_CA_CERT: undefined })).toThrow(
      /DATABASE_CA_CERT: Obrigatória em produção/,
    );
    expect(() => loadEnv({ ...prod, DATABASE_CA_CERT: '' })).toThrow(/DATABASE_CA_CERT/);
    expect(loadEnv(prod).DATABASE_CA_CERT).toBe(CA_PEM);
  });

  it('DATABASE_CA_CERT precisa ser PEM e é opcional fora de produção', () => {
    expect(() => loadEnv({ DATABASE_URL, DATABASE_CA_CERT: 'nao-e-pem' })).toThrow(
      /DATABASE_CA_CERT: Precisa ser um PEM/,
    );
    expect(loadEnv({ DATABASE_URL }).DATABASE_CA_CERT).toBeUndefined();
  });

  it('em produção, WEB_ORIGIN é obrigatória: só a origem, com https', () => {
    // Sem a variável vale o padrão http://localhost:3000, que não serve em produção.
    expect(() => loadEnv({ ...prod, WEB_ORIGIN: undefined })).toThrow(/WEB_ORIGIN/);
    for (const bad of [
      'http://loja.example.test',
      'https://loja.example.test/',
      'https://loja.example.test/admin',
    ]) {
      expect(() => loadEnv({ ...prod, WEB_ORIGIN: bad })).toThrow(/WEB_ORIGIN/);
    }
    expect(loadEnv(prod).WEB_ORIGIN).toBe('https://loja.example.test');
    // Fora de produção, o padrão local continua valendo.
    expect(loadEnv({ DATABASE_URL }).WEB_ORIGIN).toBe('http://localhost:3000');
  });

  it('em produção, o erro de configuração nunca traz valores', () => {
    const origin = 'http://origem-ficticia.example.test';
    try {
      loadEnv({ ...prod, WEB_ORIGIN: origin, DATABASE_CA_CERT: '' });
      throw new Error('deveria falhar');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/WEB_ORIGIN/);
      expect(message).toMatch(/DATABASE_CA_CERT/);
      for (const value of [origin, DATABASE_URL, ...Object.values(pix)]) {
        expect(message).not.toContain(value);
      }
    }
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
