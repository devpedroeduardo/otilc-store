import { expect, test } from '@playwright/test';
import { orderStatus, variantOf } from './support/db';

const SLUG = '05-camiseta-preta';

test('compra: catálogo → categoria → produto → carrinho → pedido com estoque reservado', async ({
  page,
}) => {
  await page.goto('/');
  const grid = page.locator('.grid');
  await expect(grid.locator('.card')).toHaveCount(17);

  // Filtro de categoria: só as 5 camisetas do Drop 00.
  await page.getByRole('navigation', { name: 'Categorias' }).getByText('Camisetas').click();
  await expect(page).toHaveURL(/\?categoria=camisetas$/);
  await expect(grid.locator('.card')).toHaveCount(5);
  await expect(grid.getByText('Air Jordan 3 Retro')).toHaveCount(0);

  await grid.getByRole('link', { name: /Camiseta Preta/ }).click();
  await expect(page).toHaveURL(new RegExp(`/produto/${SLUG}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Camiseta Preta');

  await page.getByRole('button', { name: 'Adicionar ao carrinho' }).click();
  await page.getByRole('link', { name: 'Ver carrinho →' }).click();
  await expect(page).toHaveURL(/\/carrinho$/);
  await expect(page.getByRole('list', { name: 'Itens no carrinho' })).toContainText(
    'Camiseta Preta',
  );

  await page.getByLabel('Nome').fill('Ana Souza');
  await page.getByLabel('E-mail').fill('ana@example.com');
  await page.getByLabel('WhatsApp com DDD').fill('(85) 99999-0000');
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Finalizar pedido' }).click();
  expect((await created).status()).toBe(201);

  const confirmation = page.getByRole('status');
  await expect(confirmation).toContainText('Pedido criado. Suas peças estão reservadas até as');
  const number = Number(
    (await confirmation.getByText(/^Pedido nº \d+$/).textContent())?.replace(/\D/g, ''),
  );

  // Efeito no banco: pedido aguardando pagamento e a unidade presa na reserva.
  expect(await orderStatus(number)).toBe('PENDING_PAYMENT');
  expect(await variantOf(SLUG)).toMatchObject({ stock: 1, reserved: 1 });

  // E na loja: a peça não pode mais ser comprada.
  await expect(async () => {
    await page.goto(`/produto/${SLUG}`);
    await expect(page.getByRole('status')).toHaveText(
      'Esta peça está reservada em um pedido aguardando pagamento.',
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Adicionar ao carrinho' })).toHaveCount(0);
});
