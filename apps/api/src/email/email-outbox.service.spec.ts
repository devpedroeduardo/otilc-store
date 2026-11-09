import { setImmediate as nextTick } from 'node:timers/promises';
import { loadEnv } from '../config/env';
import type { Database } from '../db/client';
import type { EmailSender } from './email-sender';
import { EmailOutboxService } from './email-outbox.service';

const DATABASE_URL = 'postgres://u@localhost:5432/db';

function service(nodeEnv: 'test' | 'development') {
  const env = loadEnv({ DATABASE_URL, NODE_ENV: nodeEnv });
  const sender: EmailSender = { send: jest.fn() };
  const outbox = new EmailOutboxService({} as Database, env, sender);
  const run = jest.spyOn(outbox, 'run').mockResolvedValue({ sent: 0, retried: 0, failed: 0 });
  return { outbox, run };
}

describe('EmailOutboxService: timer e gatilho (spec-036)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('em NODE_ENV=test, não liga o timer e o gatilho não faz nada', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { outbox, run } = service('test');

    outbox.onModuleInit();
    outbox.kick();
    await nextTick();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('fora de teste, o gatilho roda uma rodada sem bloquear quem chamou', async () => {
    const { outbox, run } = service('development');
    outbox.onModuleInit();

    outbox.kick();
    // Não roda na mesma volta: a resposta do webhook ou do painel não espera.
    expect(run).not.toHaveBeenCalled();
    await nextTick();
    expect(run).toHaveBeenCalledTimes(1);

    outbox.onApplicationShutdown();
  });

  it('gatilho com rodada em andamento é descartado (skipIfRunning)', async () => {
    const { outbox, run } = service('development');
    let finish!: () => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ sent: 0, retried: 0, failed: 0 });
        }),
    );
    outbox.onModuleInit();

    outbox.kick();
    await nextTick();
    outbox.kick();
    await nextTick();
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await nextTick();
    outbox.kick();
    await nextTick();
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    outbox.onApplicationShutdown();
  });

  it('depois do shutdown, o gatilho não faz nada', async () => {
    const { outbox, run } = service('development');
    outbox.onModuleInit();
    outbox.onApplicationShutdown();

    outbox.kick();
    await nextTick();

    expect(run).not.toHaveBeenCalled();
  });
});
