import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { adminCredentials, API_URL } from './env';
import { variantOf } from './db';

/**
 * Cookies da sessão por papel. O login da API aceita 5 por minuto por IP, e a suíte com
 * `--repeat-each` passa disso. O primeiro `loginAs` de cada papel loga pela tela, como o
 * administrador faz; os seguintes, no mesmo worker, reaproveitam a sessão. Nenhum teste faz logout.
 */
const sessions = new Map<'OWNER' | 'STAFF', Awaited<ReturnType<BrowserContext['cookies']>>>();

/** Login pela tela na primeira vez de cada papel; depois, a mesma sessão num contexto novo. */
export async function loginAs(page: Page, role: 'OWNER' | 'STAFF'): Promise<void> {
  const saved = sessions.get(role);
  if (saved) {
    await page.context().addCookies(saved);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Produtos' })).toBeVisible();
    return;
  }
  const { email, password } = adminCredentials(role);
  await page.goto('/admin/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  const login = page.waitForResponse(
    (r) => r.url().endsWith('/api/admin/session') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Entrar' }).click();
  expect((await login).status()).toBe(200);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Produtos' })).toBeVisible();
  sessions.set(role, await page.context().cookies());
}

/** Pedido criado direto na API pública (como o checkout faz), para o painel ter o que mudar. */
export async function createOrder(
  request: APIRequestContext,
  slug: string,
): Promise<{ id: string; number: number }> {
  const variant = await variantOf(slug);
  const response = await request.post(`${API_URL}/api/orders`, {
    data: {
      items: [{ variantId: variant.id, quantity: 1 }],
      customer: { name: 'Bruno Lima', email: 'bruno@example.com', phone: '+5585988880000' },
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; number: number };
}
