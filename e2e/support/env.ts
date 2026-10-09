/**
 * Endereços dos testes E2E da loja + painel. Portas próprias (não as do `npm run dev`) para
 * nunca reaproveitar um servidor ligado no banco de desenvolvimento.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3336);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3006);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Banco exclusivo dos testes E2E do navegador. */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://otilc:otilc@localhost:5432/otilc_test_006';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Os testes truncam tabelas: só rodam contra um Postgres local e nunca contra o banco
 * `otilc` de desenvolvimento.
 */
export function assertE2EDatabaseUrl(url: string): void {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`E2E bloqueado: o host "${parsed.hostname}" do banco não é local.`);
  }
  if (!name.startsWith('otilc_test')) {
    throw new Error(`E2E bloqueado: o banco "${name}" não é de teste (esperado otilc_test*).`);
  }
}

/** Credenciais geradas no globalSetup; só existem em memória (process.env), nunca em arquivo. */
export function adminCredentials(role: 'OWNER' | 'STAFF'): { email: string; password: string } {
  const email = process.env[`E2E_${role}_EMAIL`];
  const password = process.env[`E2E_${role}_PASSWORD`];
  if (!email || !password) throw new Error('Admin de teste ausente: o globalSetup não rodou.');
  return { email, password };
}
