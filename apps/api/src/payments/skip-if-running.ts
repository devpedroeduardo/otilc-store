/**
 * Envolve a rodada de um job de timer: se a anterior ainda não terminou nesta instância, a nova é
 * pulada (não enfileira). Erro da rodada vai para `onError` e não derruba a API.
 */
export function skipIfRunning(
  round: () => Promise<unknown>,
  onError: (err: unknown) => void,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await round();
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  };
}
