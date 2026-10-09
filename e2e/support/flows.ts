import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { adminCredentials, API_URL } from './env';
import { variantOf } from './db';

/** Login pela tela, como o administrador faz. */
export async function loginAs(page: Page, role: 'OWNER' | 'STAFF'): Promise<void> {
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
