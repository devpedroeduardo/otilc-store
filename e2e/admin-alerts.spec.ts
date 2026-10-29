import { expect, test } from '@playwright/test';
import { alertResolved, seedAlert } from './support/db';
import { createOrder, loginAs } from './support/flows';

test('admin vê o alerta com tipo, pedido e orientação e o marca como resolvido', async ({
  page,
  request,
}) => {
  const order = await createOrder(request, '12-casaco');
  await seedAlert(order.id, 'DUPLICATE_PAYMENT', 25980);

  await loginAs(page, 'OWNER');
  await page.goto('/admin/alerts');
  const row = page.getByRole('row').filter({ hasText: `#${order.number}` });
  await expect(row.getByText('Pagamento em dobro')).toBeVisible();
  await expect(
    row.getByText('Estorne o pagamento excedente no painel do Mercado Pago.'),
  ).toBeVisible();
  await expect(row.getByRole('link', { name: `#${order.number}` })).toHaveAttribute(
    'href',
    `/admin/orders/${order.id}`,
  );
  await expect(row.getByRole('button', { name: 'Retomar conciliação' })).toHaveCount(0);

  const response = page.waitForResponse(
    (r) => /\/api\/admin\/alerts\/[^/]+\/resolve$/.test(r.url()) && r.request().method() === 'POST',
  );
  await row.getByRole('button', { name: 'Marcar resolvido' }).click();
  expect((await response).status()).toBe(200);

  await expect(page.getByRole('row').filter({ hasText: `#${order.number}` })).toHaveCount(0);
  expect(await alertResolved(order.id)).toBe(true);

  await page.goto('/admin/alerts?situacao=resolvidos');
  await expect(page.getByRole('row').filter({ hasText: `#${order.number}` })).toBeVisible();
});
