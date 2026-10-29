/**
 * Proteção do build (spec-016): o mock do admin nunca vai para a produção da Vercel.
 * Qualquer valor diferente de vazio ou `0` conta como ligado. Fora da produção da Vercel
 * (build local, `test:e2e:web`), não faz nada.
 */
export function assertAdminMockOff(env: Record<string, string | undefined>): void {
  if (env.VERCEL_ENV !== 'production') return;
  const mock = env.NEXT_PUBLIC_ADMIN_MOCK;
  if (mock && mock !== '0') {
    throw new Error(
      'NEXT_PUBLIC_ADMIN_MOCK está ligado no build de produção da Vercel. Remova a variável do painel.',
    );
  }
}
