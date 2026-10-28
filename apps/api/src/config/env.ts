import { z } from 'zod';

/** Variável vazia no .env (`MP_ACCESS_TOKEN=`) conta como ausente. */
const blankAsMissing = (v: unknown) => (v === '' ? undefined : v);

const PIX_KEYS = ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'MP_NOTIFICATION_URL'] as const;

/** Variáveis de ambiente validadas na inicialização: a API não sobe com configuração errada. */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3333),
    DATABASE_URL: z.string().url(),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    ORDER_HOLD_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(30),
    // Pix com Mercado Pago (spec-014). Valores reais só no .env, nunca no repositório.
    MP_ACCESS_TOKEN: z.preprocess(blankAsMissing, z.string().min(8).max(500).optional()),
    MP_WEBHOOK_SECRET: z.preprocess(blankAsMissing, z.string().min(8).max(500).optional()),
    MP_NOTIFICATION_URL: z.preprocess(
      blankAsMissing,
      z
        .string()
        .url()
        .refine((url) => url.startsWith('https://'), 'A URL de notificação precisa ser https.')
        .optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of PIX_KEYS) {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'Obrigatória em produção.' });
    }
  });

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
  notificationUrl: string;
}

/** Configuração do Pix, ou `null` se faltar qualquer variável (Pix desligado fora de produção). */
export function pixConfig(env: Env): PixConfig | null {
  const { MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, MP_NOTIFICATION_URL } = env;
  if (!MP_ACCESS_TOKEN || !MP_WEBHOOK_SECRET || !MP_NOTIFICATION_URL) return null;
  return {
    accessToken: MP_ACCESS_TOKEN,
    webhookSecret: MP_WEBHOOK_SECRET,
    notificationUrl: MP_NOTIFICATION_URL,
  };
}

export const ENV = Symbol('ENV');
