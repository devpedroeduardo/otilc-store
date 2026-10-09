import { defineConfig, devices } from '@playwright/test';
import {
  API_PORT,
  API_URL,
  assertE2EDatabaseUrl,
  E2E_DATABASE_URL,
  WEB_PORT,
  WEB_URL,
} from './e2e/support/env';

assertE2EDatabaseUrl(E2E_DATABASE_URL);

/**
 * E2E da loja e do painel contra a API real (spec-006). Sobe API e loja em portas próprias,
 * ligadas no banco de teste; o globalSetup migra, popula e cria os admins.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results/test-results',
  globalSetup: './e2e/global-setup.ts',
  // Os testes compartilham o estoque do mesmo banco: um de cada vez.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: './e2e/.results/report', open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    locale: 'pt-BR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // tsx direto (sem --env-file): o apps/api/.env de desenvolvimento não entra em jogo.
      command: 'npx tsx src/db/migrate.ts && npx tsx src/main.ts',
      cwd: './apps/api',
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        WEB_ORIGIN: WEB_URL,
        ORDER_HOLD_MINUTES: '30',
      },
    },
    {
      // O cache de fetch do Next guardaria IDs de um seed anterior: começa vazio a cada execução.
      command: `rm -rf .next/cache/fetch-cache && npx next dev -p ${WEB_PORT}`,
      cwd: './apps/web',
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      // Variáveis do processo têm precedência sobre o .env.local.
      env: {
        API_URL,
        NEXT_PUBLIC_API_URL: API_URL,
        NEXT_PUBLIC_ADMIN_MOCK: '0',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
});
