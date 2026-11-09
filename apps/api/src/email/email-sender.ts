import { Logger } from '@nestjs/common';
import { z } from 'zod';

/** Um e-mail pronto para sair. `ref` identifica o pedido no log; nunca o destinatário. */
export interface EmailMessage {
  ref: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo: string | null;
  idempotencyKey: string;
}

export interface EmailSender {
  /** Devolve o id da mensagem no provedor. Falha lança `EmailSendError`. */
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * Falha do envio. `temporary`: rede, tempo esgotado, 429, 5xx ou envio concorrente com a mesma
 * chave de idempotência; vale tentar de novo. A mensagem nunca traz o corpo da resposta nem dados
 * do destinatário: ela vai para `email_outbox.last_error` e para o log.
 */
export class EmailSendError extends Error {
  override readonly name = 'EmailSendError';

  constructor(
    message: string,
    readonly temporary: boolean,
  ) {
    super(message);
  }
}

const RESEND_API = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

const sentSchema = z.object({ id: z.string().min(1).max(100) });
const errorSchema = z.object({ name: z.unknown().optional() });

/** Código de erro do Resend (`validation_error`...), só se for um identificador. */
function errorCode(body: unknown): string | null {
  const parsed = errorSchema.safeParse(body);
  const name = parsed.success ? parsed.data.name : undefined;
  return typeof name === 'string' && /^[a-z0-9_]{1,64}$/.test(name) ? name : null;
}

/**
 * Erro HTTP que vale tentar de novo. O 409 `concurrent_idempotent_requests` quer dizer que outro
 * envio com a mesma chave ainda está em andamento; os demais 4xx não mudam com nova tentativa.
 */
function isTemporary(status: number, code: string | null): boolean {
  return status === 429 || status >= 500 || code === 'concurrent_idempotent_requests';
}

/** Resend pela API HTTP, com `fetch` nativo e sem SDK (spec-036). */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    // O `fetch` global é lido a cada chamada, e não guardado aqui: o e2e troca o global por um fake.
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const body = {
      from: this.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(RESEND_API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError' ? 'tempo esgotado' : 'rede';
      throw new EmailSendError(`Resend indisponível (${reason}).`, true);
    }
    if (!res.ok) {
      const code = errorCode(await res.json().catch(() => null));
      throw new EmailSendError(
        `Resend respondeu ${res.status}${code ? ` (${code})` : ''}.`,
        isTemporary(res.status, code),
      );
    }
    const parsed = sentSchema.safeParse(await res.json().catch(() => null));
    // 2xx sem id legível conta como enviado: o Resend aceitou o e-mail, e repetir o envio depois
    // de 24 h (quando a chave de idempotência expira) mandaria um segundo.
    return { providerMessageId: parsed.success ? parsed.data.id : 'desconhecido' };
  }
}

/**
 * `EMAIL_PROVIDER=log`: não chama rede. Registra só o pedido e o assunto e devolve sucesso, para a
 * outbox andar igual em dev, teste e na produção até o domínio ser verificado.
 */
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger(LogEmailSender.name);

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    this.logger.log(
      `E-mail não enviado (EMAIL_PROVIDER=log) do pedido ${message.ref}: "${message.subject}".`,
    );
    return { providerMessageId: 'log' };
  }
}
