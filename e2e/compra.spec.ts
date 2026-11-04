import { expect, test } from '@playwright/test';
import { orderStatus, releaseOrder, variantOf } from './support/db';

const SLUG = '05-camiseta-preta';

// Pedido feito pela tela, cancelado no afterEach (roda mesmo se o teste falhar depois do checkout)
// para a camiseta não ficar reservada até o fim da execução. A loja guarda a página do produto
// por 30 s (revalidate em apps/web/src/lib/api.ts), então o hook espera ela mostrar a peça à
// venda de novo: sem isso, a próxima execução (--repeat-each) abriria a página ainda reservada.
const createdOrders: string[] = [];

// O teste já passa dos 30 s esperando o cache; o hook precisa de folga além disso.
test.setTimeout(120_000);

test.afterEach(async ({ page }) => {
  const ids = createdOrders.splice(0);
  for (const id of ids) await releaseOrder(id);
  if (ids.length === 0) return;
  await expect(async () => {
    await page.goto(`/produto/${SLUG}`);
    await expect(page.getByRole('button', { name: 'Adicionar ao carrinho' })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 45_000 });
});

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
  await expect(page).toHaveURL(/\/produto\/05-camiseta-preta$/);
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
  const response = await created;
  expect(response.status()).toBe(201);
  const order = (await response.json()) as { id: string; number: number };
  createdOrders.push(order.id);

  // Depois do checkout a loja leva o cliente à página do pedido. Sem credenciais do Mercado
  // Pago no ambiente de E2E, o Pix fica desligado e a página avisa.
  await expect(page).toHaveURL((url) => url.pathname === `/pedido/${order.id}`);
  await expect(page.getByRole('heading', { name: 'Pix indisponível' })).toBeVisible();
  const number = order.number;

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
