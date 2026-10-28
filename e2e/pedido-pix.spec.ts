import { expect, test, type Route } from '@playwright/test';

// PNG de 1x1 pixel.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ORDER_ID = '3b241101-e2bb-4255-8caf-4136c566a962';

test('pedido: a contagem segue o expiresAt e, ao zerar, para de consultar e esconde o Pix', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-28T15:00:00Z') });

  const charge = {
    orderId: ORDER_ID,
    orderStatus: 'PENDING_PAYMENT',
    status: 'PENDING',
    amountCents: 25980,
    qrCode: '00020126580014br.gov.bcb.pix-teste',
    qrCodeBase64: PNG,
    // 1 minuto de prazo depois do ponto em que o relógio simulado é parado.
    expiresAt: '2026-10-28T15:06:00.000Z',
  };
  let gets = 0;
  const reply = (route: Route, status: number) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(charge) });
  await page.route(`**/api/orders/${ORDER_ID}/pix`, (route) => {
    if (route.request().method() === 'POST') return reply(route, 201);
    gets += 1;
    return reply(route, 200);
  });

  await page.goto(`/pedido/${ORDER_ID}`);
  await expect(page.getByRole('heading', { name: 'Aguardando pagamento' })).toBeVisible();
  await expect(page.getByAltText('QR code do Pix')).toBeVisible();
  await expect(page.getByLabel('Pix copia e cola')).toHaveValue(charge.qrCode);
  // O relógio simulado corre solto até aqui; para em um instante conhecido.
  await page.clock.pauseAt(new Date('2026-10-28T15:05:00Z'));
  await expect(page.locator('time')).toHaveText('01:00');

  // A contagem anda com o relógio e a página consulta a cada 5 segundos.
  await page.clock.runFor(30_000);
  await expect(page.locator('time')).toHaveText('00:30');
  expect(gets).toBeGreaterThanOrEqual(5);

  // Ao zerar: esconde QR e copia e cola, mostra "Pedido expirado".
  await page.clock.runFor(31_000);
  await expect(page.getByRole('heading', { name: 'Pedido expirado' })).toBeVisible();
  await expect(page.getByAltText('QR code do Pix')).toHaveCount(0);
  await expect(page.getByLabel('Pix copia e cola')).toHaveCount(0);

  // E para de consultar (a única consulta depois do vencimento é a última conferência).
  await page.clock.runFor(1_000);
  const after = gets;
  await page.clock.runFor(30_000);
  expect(gets).toBe(after);
});
