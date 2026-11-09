import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  EmailSendError,
  LogEmailSender,
  ResendEmailSender,
  type EmailMessage,
} from './email-sender';

// Chave gerada na hora: nenhum valor real no teste.
const apiKey = `re_teste_${randomBytes(16).toString('hex')}`;
const FROM = 'OTILC <pedidos@example.com>';
const ORDER_ID = '3b241101-e2bb-4255-8caf-4136c566a962';

const message: EmailMessage = {
  ref: ORDER_ID,
  to: 'ana@example.com',
  subject: 'Pedido nº 42 confirmado',
  html: '<p>Olá, Ana Souza</p>',
  text: 'Olá, Ana Souza',
  replyTo: 'atendimento@example.com',
  idempotencyKey: `order-confirmation/${ORDER_ID}`,
};

function fakeFetch(response: () => Promise<Response> | Response) {
  return jest.fn(async (..._args: Parameters<typeof fetch>) => response());
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Tudo o que os loggers receberam, em texto. */
function logged(spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' ')))
    .join('\n');
}

describe('ResendEmailSender (spec-036)', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('envia por POST com chave, idempotência, remetente, destinatário, assunto, corpo e reply-to', async () => {
    const fetchFn = fakeFetch(() => json({ id: 'msg-ficticia-1' }));
    const sender = new ResendEmailSender(apiKey, FROM, fetchFn);

    await expect(sender.send(message)).resolves.toEqual({ providerMessageId: 'msg-ficticia-1' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `order-confirmation/${ORDER_ID}`,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      from: FROM,
      to: ['ana@example.com'],
      subject: 'Pedido nº 42 confirmado',
      html: '<p>Olá, Ana Souza</p>',
      text: 'Olá, Ana Souza',
      reply_to: 'atendimento@example.com',
    });
  });

  it('sem reply-to, o campo não vai', async () => {
    const fetchFn = fakeFetch(() => json({ id: 'msg-ficticia-2' }));
    await new ResendEmailSender(apiKey, FROM, fetchFn).send({ ...message, replyTo: null });
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).not.toHaveProperty('reply_to');
  });

  it.each([
    [500, 'internal_server_error', true],
    [503, null, true],
    [429, 'rate_limit_exceeded', true],
    [409, 'concurrent_idempotent_requests', true],
    [409, 'invalid_idempotent_request', false],
    [422, 'validation_error', false],
    [403, 'invalid_from_address', false],
    [401, 'missing_api_key', false],
  ])('%i (%s) → temporário: %s', async (status, name, temporary) => {
    const fetchFn = fakeFetch(() =>
      json({ statusCode: status, name, message: 'Invalid `to` field: ana@example.com' }, status),
    );
    const err = await new ResendEmailSender(apiKey, FROM, fetchFn).send(message).catch((e) => e);

    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).temporary).toBe(temporary);
    expect((err as EmailSendError).message).toBe(
      `Resend respondeu ${status}${name ? ` (${name})` : ''}.`,
    );
  });

  it('rede e tempo esgotado são temporários', async () => {
    const network = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(new ResendEmailSender(apiKey, FROM, network).send(message)).rejects.toMatchObject({
      temporary: true,
      message: 'Resend indisponível (rede).',
    });
    const timeout = fakeFetch(() =>
      Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
    );
    await expect(new ResendEmailSender(apiKey, FROM, timeout).send(message)).rejects.toMatchObject({
      temporary: true,
      message: 'Resend indisponível (tempo esgotado).',
    });
  });

  it('código de erro fora do formato não entra na mensagem', async () => {
    const fetchFn = fakeFetch(() => json({ name: 'ana@example.com' }, 422));
    const err = (await new ResendEmailSender(apiKey, FROM, fetchFn)
      .send(message)
      .catch((e) => e)) as EmailSendError;
    expect(err.message).toBe('Resend respondeu 422.');
  });

  it('erros nunca trazem e-mail, nome, corpo da resposta nem a chave, e nada vai para o log', async () => {
    const bodies = [
      () => json({ name: 'validation_error', message: 'ana@example.com Ana Souza' }, 422),
      () => json({ message: 'ana@example.com' }, 500),
      () => Promise.reject(new TypeError('fetch failed ana@example.com')),
    ];
    for (const body of bodies) {
      const err = (await new ResendEmailSender(apiKey, FROM, fakeFetch(body))
        .send(message)
        .catch((e) => e)) as Error;
      for (const secret of ['ana@example.com', 'Ana Souza', apiKey]) {
        expect(err.message).not.toContain(secret);
      }
    }
    expect(logged(spies)).toBe('');
  });
});

describe('LogEmailSender (spec-036)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('não chama rede e registra só o pedido e o assunto', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(new LogEmailSender().send(message)).resolves.toEqual({ providerMessageId: 'log' });

    expect(fetchSpy).not.toHaveBeenCalled();
    const text = logged([log]);
    expect(text).toContain(ORDER_ID);
    expect(text).toContain('Pedido nº 42 confirmado');
    for (const pii of ['ana@example.com', 'Ana Souza', 'atendimento@example.com']) {
      expect(text).not.toContain(pii);
    }
  });
});
