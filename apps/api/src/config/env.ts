import { z } from 'zod';

/** Variável vazia no .env (`MP_ACCESS_TOKEN=`) conta como ausente. */
const blankAsMissing = (v: unknown) => (v === '' ? undefined : v);

const PIX_KEYS = ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET'] as const;

/** Variáveis de ambiente validadas na inicialização: a API não sobe com configuração errada. */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3333),
    DATABASE_URL: z.string().url(),
    // Certificado raiz público do Supabase (PEM), para o SSL verificado do banco (spec-016).
    // Obrigatório em produção; o uso fica em db/client.ts, que o migrator também usa.
    DATABASE_CA_CERT: z.preprocess(
      blankAsMissing,
      z
        .string()
        .refine((pem) => pem.includes('-----BEGIN CERTIFICATE-----'), 'Precisa ser um PEM.')
        .optional(),
    ),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    ORDER_HOLD_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(30),
    // Intervalo da conciliação periódica do Pix com o Mercado Pago (spec-015): 30 s a 1 h.
    PAYMENT_RECONCILIATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(60 * 60_000)
      .default(5 * 60_000),
    // Pix com Mercado Pago (spec-014). Valores reais só no .env, nunca no repositório. A URL do
    // webhook é configurada no painel do Mercado Pago, não aqui (API de Orders, spec-021).
    MP_ACCESS_TOKEN: z.preprocess(blankAsMissing, z.string().min(8).max(500).optional()),
    MP_WEBHOOK_SECRET: z.preprocess(blankAsMissing, z.string().min(8).max(500).optional()),
    // E-mail de confirmação (spec-036). `log` não chama rede: dev, teste e a produção até o
    // domínio ser verificado no Resend. A chave real só no painel do Render.
    EMAIL_PROVIDER: z.preprocess(blankAsMissing, z.enum(['resend', 'log']).default('log')),
    RESEND_API_KEY: z.preprocess(blankAsMissing, z.string().min(8).max(500).optional()),
    // Remetente como o Resend aceita: `pedidos@dominio` ou `Nome <pedidos@dominio>`.
    EMAIL_FROM: z.preprocess(
      blankAsMissing,
      z
        .string()
        .max(200)
        .regex(/^(?:[^<>@\r\n]+ <[^\s<>@]+@[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+)$/, 'Remetente inválido.')
        .optional(),
    ),
    // Reply-to e contato do rodapé; sem ele, o e-mail sai sem os dois.
    EMAIL_REPLY_TO: z.preprocess(blankAsMissing, z.email().max(160).optional()),
    EMAIL_OUTBOX_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60 * 60_000)
      .default(30_000),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === 'resend') {
      for (const key of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Obrigatória com EMAIL_PROVIDER=resend.',
          });
      }
    }
    if (env.NODE_ENV !== 'production') return;
    for (const key of PIX_KEYS) {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'Obrigatória em produção.' });
    }
    if (!env.DATABASE_CA_CERT)
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_CA_CERT'],
        message: 'Obrigatória em produção.',
      });
    // O padrão (http://localhost:3000) não serve em produção. CORS e a checagem de Origin do admin
    // comparam a origem exata: nada de caminho nem barra no fim.
    if (!isHttpsOrigin(env.WEB_ORIGIN))
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'Obrigatória em produção: só a origem da loja, com https e sem barra no fim.',
      });
  });

function isHttpsOrigin(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value;
}

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Só o nome da variável e o motivo: o valor (que pode ser segredo) nunca entra na mensagem.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${problems}`);
  }
  return parsed.data;
}

export interface PixConfig {
  accessToken: string;
  webhookSecret: string;
}

/** Configuração do Pix, ou `null` se faltar qualquer variável (Pix desligado fora de produção). */
export function pixConfig(env: Env): PixConfig | null {
  const { MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET } = env;
  if (!MP_ACCESS_TOKEN || !MP_WEBHOOK_SECRET) return null;
  return { accessToken: MP_ACCESS_TOKEN, webhookSecret: MP_WEBHOOK_SECRET };
}

/** Provedor de e-mail já resolvido: com `resend`, chave e remetente garantidos pelo schema. */
export type EmailConfig =
  | { provider: 'log'; replyTo: string | null }
  | { provider: 'resend'; apiKey: string; from: string; replyTo: string | null };

export function emailConfig(env: Env): EmailConfig {
  const replyTo = env.EMAIL_REPLY_TO ?? null;
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY && env.EMAIL_FROM) {
    return { provider: 'resend', apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, replyTo };
  }
  return { provider: 'log', replyTo };
}

export const ENV = Symbol('ENV');
