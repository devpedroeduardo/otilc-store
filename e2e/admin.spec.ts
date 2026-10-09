import { expect, test, type Page } from '@playwright/test';
import { orderStatus, variantOf } from './support/db';
import { WEB_URL } from './support/env';
import { createOrder, loginAs } from './support/flows';

async function openProduct(page: Page, name: string): Promise<void> {
  await page.goto('/admin');
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('link', { name: 'Abrir' })
    .click();
  await expect(page.getByRole('heading', { name: 'Editar produto' })).toBeVisible();
}

async function openOrder(page: Page, number: number): Promise<void> {
  await page.goto('/admin/orders');
  await page
    .getByRole('row')
    .filter({ hasText: `#${number}` })
    .getByRole('link', { name: 'Detalhe' })
    .click();
  await expect(page.getByText(`PEDIDO · #${number}`)).toBeVisible();
}

/** Muda o status pelo botão do painel e exige o 200 da API real (sem 403 do CSRF). */
async function changeStatus(page: Page, button: string, expected: string): Promise<void> {
  const response = page.waitForResponse(
    (r) => /\/api\/admin\/orders\/[^/]+\/status$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: button }).click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('.panel').getByText(new RegExp(`^${expected} · `))).toBeVisible();
}

test('acessar /admin sem sessão redireciona para o login', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto('/admin/orders');
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('OWNER muda o estoque pelo painel: o rewrite repassa o Origin da loja', async ({ page }) => {
  await loginAs(page, 'OWNER');
  await openProduct(page, 'Boné Trucker');
  const variant = await variantOf('15-bone-trucker');

  await page.getByLabel('Estoque').fill('3');
  const response = page.waitForResponse((r) =>
    r.url().endsWith(`/api/admin/variants/${variant.id}/stock`),
  );
  await page.getByRole('button', { name: 'Atualizar' }).click();
  const put = await response;
  // A chamada sai da origem da loja (rewrite do Next) e chega na API com o Origin aceito.
  expect(put.url()).toBe(`${WEB_URL}/api/admin/variants/${variant.id}/stock`);
  expect(put.request().method()).toBe('PUT');
  expect(put.status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('Estoque atualizado.');
  expect(await variantOf('15-bone-trucker')).toMatchObject({ stock: 3, reserved: 0 });

  // Controle: pelo mesmo rewrite, com a sessão válida, outro Origin é barrado pela API.
  // Prova que o 200 acima não veio de uma checagem desligada, e sim do Origin repassado.
  const forged = await page.request.put(`/api/admin/variants/${variant.id}/stock`, {
    headers: { Origin: 'http://evil.example' },
    data: { stock: 9 },
  });
  expect(forged.status()).toBe(403);
  expect(await forged.json()).toMatchObject({ message: 'Origem não permitida.' });
  expect((await variantOf('15-bone-trucker')).stock).toBe(3);
});

test('cancelar pedido no painel devolve a unidade para a loja', async ({ page, request }) => {
  const slug = '13-corta-vento';
  const order = await createOrder(request, slug);
  expect(await variantOf(slug)).toMatchObject({ stock: 1, reserved: 1 });

  await loginAs(page, 'OWNER');
  await openOrder(page, order.number);
  await changeStatus(page, 'Cancelar', 'CANCELED');
  expect(await orderStatus(order.number)).toBe('CANCELED');
  expect(await variantOf(slug)).toMatchObject({ stock: 1, reserved: 0 });

  // A peça volta a poder ser comprada na loja.
  await expect(async () => {
    await page.goto(`/produto/${slug}`);
    await expect(page.getByRole('button', { name: 'Adicionar ao carrinho' })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 45_000 });
});

test('peça vendida aparece em cinza no fim da grade', async ({ page, request }) => {
  const slug = '11-short';
  const order = await createOrder(request, slug);

  await loginAs(page, 'OWNER');
  await openOrder(page, order.number);
  // PENDING_PAYMENT → PAID: reserved -= 1 e stock -= 1. Sem unidade livre, a loja mostra
  // a peça como vendida (status efetivo SOLD_OUT), sem mudar o status manual do produto.
  await changeStatus(page, 'Marcar pago', 'PAID');
  expect(await variantOf(slug)).toMatchObject({ stock: 0, reserved: 0 });

  const lastCard = page.locator('.grid .card').last();
  await expect(async () => {
    await page.goto('/');
    await expect(lastCard).toHaveAttribute('href', `/produto/${slug}`, { timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
  await expect(lastCard).toHaveClass(/\bout\b/);
  await expect(lastCard.locator('.pill')).toHaveText('Vendido');
  await expect(lastCard.locator('img')).toHaveCSS('filter', /grayscale\(1\)/);
});

test('STAFF não edita preço: campo desabilitado na tela e 403 na API', async ({ page }) => {
  await loginAs(page, 'STAFF');
  await expect(page.getByRole('link', { name: 'Novo produto' })).toHaveCount(0);
  await openProduct(page, 'Boné Branco');

  await expect(page.getByLabel('Preço em centavos')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Salvar produto' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Nova variação' })).toHaveCount(0);
  // Estoque continua liberado para STAFF.
  await expect(page.getByLabel('Estoque')).toBeEnabled();

  // A API é quem garante: mesmo com Origin certo e sessão válida, a edição é recusada.
  const { productId } = await variantOf('14-bone-branco');
  const patch = await page.request.patch(`/api/admin/products/${productId}`, {
    headers: { Origin: WEB_URL },
    data: { priceCents: 100 },
  });
  expect(patch.status()).toBe(403);
  expect(await patch.json()).toMatchObject({ message: 'Sem permissão para esta ação.' });
});
