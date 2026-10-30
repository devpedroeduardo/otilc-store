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

const CHARGE = {
  orderId: ORDER_ID,
  orderStatus: 'PENDING_PAYMENT',
  status: 'PENDING',
  amountCents: 25980,
  qrCode: '00020126580014br.gov.bcb.pix-teste',
  qrCodeBase64: PNG,
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const UNAVAILABLE = { statusCode: 503, code: 'PIX_UNAVAILABLE', message: 'indisponível' };
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// O `next dev` do E2E liga o reactStrictMode: o efeito da página roda duas vezes (duplo mount),
// o que é o cenário do achado 2 da homologação da spec-021.
test('pedido: o duplo mount do StrictMode gera 1 POST /pix e a tela não mostra "Pix indisponível"', async ({
  page,
}) => {
  // Se o 2º POST existir, ele chega primeiro e com erro: antes da correção a tela piscava.
  const posts: number[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as { __flash: boolean };
    w.__flash = false;
    new MutationObserver(() => {
      if (document.body?.textContent?.includes('Pix indisponível')) w.__flash = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.route(`**/api/orders/${ORDER_ID}/pix`, async (route) => {
    if (route.request().method() !== 'POST') return json(route, 200, CHARGE);
    posts.push(posts.length + 1);
    if (posts.length === 1) {
      await delay(600);
      return json(route, 201, CHARGE);
    }
    return json(route, 503, UNAVAILABLE);
  });

  await page.goto(`/pedido/${ORDER_ID}`);
  await expect(page.getByRole('heading', { name: 'Aguardando pagamento' })).toBeVisible();
  // Folga para qualquer resposta tardia de um 2º POST chegar.
  await page.waitForTimeout(1_000);

  expect(posts).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __flash: boolean }).__flash)).toBe(
    false,
  );
  await expect(page.getByAltText('QR code do Pix')).toBeVisible();
});

test('pedido: resposta de erro atrasada não troca o QR já na tela', async ({ page }) => {
  // 1º POST lento e com sucesso; qualquer POST a mais responde erro, e depois dele.
  const posts: number[] = [];
  await page.route(`**/api/orders/${ORDER_ID}/pix`, async (route) => {
    if (route.request().method() !== 'POST') return json(route, 200, CHARGE);
    posts.push(posts.length + 1);
    if (posts.length === 1) {
      await delay(1_500);
      return json(route, 201, CHARGE);
    }
    return json(route, 503, UNAVAILABLE);
  });

  await page.goto(`/pedido/${ORDER_ID}`);
  await expect(page.getByAltText('QR code do Pix')).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(page.getByAltText('QR code do Pix')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pix indisponível' })).toHaveCount(0);
  expect(posts).toHaveLength(1);
});

test('pedido: "Tentar de novo" depois de um erro real faz um único POST por clique', async ({
  page,
}) => {
  let posts = 0;
  await page.route(`**/api/orders/${ORDER_ID}/pix`, (route) => {
    if (route.request().method() !== 'POST') return json(route, 200, CHARGE);
    posts += 1;
    // Falha só na 1ª criação; a nova tentativa funciona.
    return posts === 1 ? json(route, 503, UNAVAILABLE) : json(route, 201, CHARGE);
  });

  await page.goto(`/pedido/${ORDER_ID}`);
  await expect(page.getByRole('heading', { name: 'Pix indisponível' })).toBeVisible();
  expect(posts).toBe(1);

  await page.getByRole('button', { name: 'Tentar de novo' }).dblclick();
  await expect(page.getByAltText('QR code do Pix')).toBeVisible();
  await page.waitForTimeout(500);
  expect(posts).toBe(2);
});
