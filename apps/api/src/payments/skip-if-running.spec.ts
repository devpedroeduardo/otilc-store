import { skipIfRunning } from './skip-if-running';

describe('skipIfRunning', () => {
  it('pula a rodada enquanto a anterior não termina, e volta a rodar depois', async () => {
    let finish!: () => void;
    const round = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const tick = skipIfRunning(round, jest.fn());

    const first = tick();
    await tick();
    await tick();
    expect(round).toHaveBeenCalledTimes(1);

    finish();
    await first;
    const second = tick();
    expect(round).toHaveBeenCalledTimes(2);
    finish();
    await second;
  });

  it('erro da rodada vai para onError e não trava as seguintes', async () => {
    const onError = jest.fn();
    const failure = new Error('falhou');
    const round = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const tick = skipIfRunning(round, onError);

    await tick();
    await tick();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(round).toHaveBeenCalledTimes(2);
  });
});
