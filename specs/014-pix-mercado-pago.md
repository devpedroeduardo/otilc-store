# spec-014 — Pix com Mercado Pago (sandbox), webhook assinado e idempotente

- Papel: `backend` + `seguranca` (Forja) e `frontend` (Faísca) — ver docs/agents/roles/
- Agente sugerido: Forja (contrato, banco, API, webhook) e Faísca (página do pedido). Revisão: Lente; segunda revisão: Faísca nas partes da Forja (pagamento). O Pedro lê o diff inteiro.
- Depende de: nenhuma
- Pode rodar em paralelo com: nada que toque em `packages/shared/src/**`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/**` ou `apps/api/src/orders/**`
- Branch: `spec-014-pix-mercado-pago` (Faísca trabalha em `spec-014-pix-web`, criada a partir do commit de contrato, e a Forja faz merge dela na branch da spec antes do PR). Um PR só.

## Objetivo

O cliente cria o pedido, é levado à página do pedido, paga por Pix (QR code ou copia e cola) gerado pela API de pagamentos do Mercado Pago em sandbox, e o pedido vira `PAID` sozinho. A confirmação vem de um webhook com assinatura verificada e idempotente, ou da verificação sob demanda quando a página consulta um pedido pendente.

## Contexto

- Decisões do Pedro: nota "Grilling Pix" (rodada 1, Q1 a Q12, com o ajuste da Q11). Fatos do repositório: nota "Recon Pix".
- Hoje: enum `order_status` com `PENDING_PAYMENT`, `PAID`, `CANCELED`, `EXPIRED`, `SHIPPED`. A reserva dura `ORDER_HOLD_MINUTES` (30). O job de `order-expiration.service.ts` expira pedidos com `FOR UPDATE SKIP LOCKED` e `lockOrder`. A única transição para `PAID` é a do painel (`admin-orders.service.ts`), que baixa `reserved` e `stock` sob as mesmas travas.
- Leia o `README.md` ("Destaques técnicos") e os testes de concorrência de `apps/api/test/orders.e2e-spec.ts` e `apps/api/test/admin-orders.e2e-spec.ts`. Nenhuma dessas garantias pode regredir.
- A spec-010 exige RLS em **toda** tabela do `public` (`apps/api/test/rls.e2e-spec.ts`). As tabelas novas precisam de `ENABLE ROW LEVEL SECURITY` na migração, sem `FORCE` e sem policy.
- **Credenciais do Mercado Pago nunca passam pelos agentes.** O Pedro coloca os valores reais direto no `.env`. Agentes usam só `.env.example` com valores fictícios e segredos gerados na hora nos testes.

## Como fazer

### Fase 1 — Contrato (Forja, primeiro commit, antes de tudo)

Commit `feat(shared): contrato do Pix` contendo os schemas Zod, os tipos e `docs/api/pagamentos.md`. Depois dele, avise a Bússola; a Faísca começa a partir desse commit.

1. **`packages/shared/src/payments.ts`** (novo, exportado no `index.ts`):
   - `pixChargeStatusSchema`: `'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REFUNDED'`.
   - `pixChargeSchema` / `PixChargeDto`: `orderId` (uuid), `orderStatus` (o enum de pedido existente), `status` (acima), `amountCents` (inteiro > 0), `qrCode` (copia e cola), `qrCodeBase64` (PNG em base64), `expiresAt` (ISO com timezone).
   - Códigos de erro com mensagem em português: `PIX_UNAVAILABLE` (Pix desligado ou Mercado Pago fora), `ORDER_NOT_PAYABLE` (pedido não está `PENDING_PAYMENT` ou já venceu).
   - Testes `node:test` em `payments.test.ts`.
2. **Endpoints** (documentados em `docs/api/pagamentos.md`, com exemplos e respostas de erro):
   - `POST /api/orders/:id/pix` — cria ou devolve a cobrança. `201` com `PixChargeDto` ao criar, `200` se já existe uma `PENDING`. `404` pedido inexistente, `409 ORDER_NOT_PAYABLE`, `503 PIX_UNAVAILABLE`. `:id` validado como uuid.
   - `GET /api/orders/:id/pix` — devolve a cobrança mais recente e o status do pedido, e dispara a verificação sob demanda (abaixo). `404` se não há cobrança.
   - `POST /api/webhooks/mercadopago` — recebe a notificação. `200` para notificação válida (inclusive duplicada ou ignorada), `401` assinatura inválida ou fora da janela, `400` formato inválido. Corpo e query validados com Zod.

### Fase 2 — API e banco (Forja)

1. **Banco** (`schema.ts` + `npm run db:generate -w @otilc/api`, migração `0004`):
   - Enum `payment_status` (os 5 valores acima) e enum `payment_alert`: `'PAID_AFTER_EXPIRY' | 'AMOUNT_MISMATCH'`.
   - Tabela `payments`: `id` uuid pk, `order_id` fk `orders` not null, `provider` varchar com `CHECK (provider = 'mercadopago')`, `provider_payment_id` varchar **UNIQUE** not null, `status` `payment_status` not null, `amount_cents` integer com `CHECK (amount_cents > 0)`, `qr_code` text, `qr_code_base64` text, `expires_at` timestamptz not null, `last_checked_at` timestamptz null, `alert` `payment_alert` null, `approved_at` timestamptz null, `created_at` e `updated_at` timestamptz. Índice único parcial: no máximo uma cobrança `PENDING` por pedido.
   - Tabela `payment_notifications`: `id` uuid pk, `request_id` varchar **UNIQUE** not null (header `x-request-id`), `provider_payment_id` varchar not null, `received_at` timestamptz not null.
   - Na mesma migração, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` nas duas tabelas novas (sem `FORCE`, sem policy). Se o drizzle-kit não gerar isso, use uma migração custom `0005` como na spec-010.
2. **Cliente do Mercado Pago** (`apps/api/src/payments/`): `fetch` nativo do Node 22, **sem SDK** e sem dependência nova. Só duas chamadas: criar pagamento Pix (`POST /v1/payments`, `payment_method_id: 'pix'`) e consultar pagamento (`GET /v1/payments/{id}`). Respostas validadas com Zod; resposta fora do schema é tratada como falha do provedor. Timeout explícito. Atrás de uma interface injetável, para os testes usarem um cliente simulado.
3. **Criar a cobrança** (`POST /api/orders/:id/pix`):
   - Valor = `orders.totalCents` lido do banco. Nada de valor vindo do cliente.
   - `external_reference` = id do pedido; `payer.email` = e-mail do pedido; `notification_url` = `MP_NOTIFICATION_URL`; `date_of_expiration` = `orders.expiresAt`.
   - Header `X-Idempotency-Key` determinístico por pedido e tentativa (a mesma tentativa sempre gera a mesma chave).
   - Já existe `PENDING` → devolve sem chamar o Mercado Pago. Duas chamadas simultâneas para o mesmo pedido terminam com **uma** cobrança no banco (UNIQUE + `ON CONFLICT`), e as duas respostas trazem a mesma cobrança.
   - **Verifique na documentação oficial** se o Pix tem validade mínima. Se o mínimo for maior que o tempo restante do pedido, **pare e reporte à Bússola** sem escolher sozinha.
4. **Transição idempotente** (uma função só, usada pelo webhook e pela verificação sob demanda):
   - Entrada: `provider_payment_id`. Consulta o pagamento no Mercado Pago **fora** da transação. O status do corpo da notificação **nunca** é usado.
   - Numa transação, com a mesma ordem de travas do job de expiração e do painel (pedido, depois variantes em `lockOrder`), atualiza `payments.status`. Status desconhecido do Mercado Pago não muda nada e gera log sem dados sensíveis.
   - `approved` com `external_reference` igual ao pedido, valor igual a `totalCents`, moeda `BRL` e pedido `PENDING_PAYMENT` com `date_approved <= expiresAt` → pedido `PAID`, baixa `reserved` e `stock` exatamente como o painel faz. Extraia e reutilize a lógica do painel em vez de duplicar. Os testes do painel continuam passando sem alteração.
   - Pagamento aprovado com o pedido já `EXPIRED` ou `CANCELED` → pedido **não muda**, estoque **não muda**, `alert = 'PAID_AFTER_EXPIRY'`. O estorno é manual.
   - Valor, moeda ou referência divergente → pedido não muda, `alert = 'AMOUNT_MISMATCH'`.
   - Reprocessar o mesmo pagamento aprovado não faz nada: a mudança para `PAID` é condicional e só acontece uma vez.
5. **Webhook** (`POST /api/webhooks/mercadopago`):
   - Verifique a assinatura do header `x-signature` (`ts` e `v1`) com HMAC-SHA256 e `MP_WEBHOOK_SECRET`, sobre o texto que a documentação oficial define (id do pagamento, `x-request-id` e `ts`). **Confirme o formato e a unidade do `ts` na documentação** antes de implementar. Compare com `timingSafeEqual`, com tamanho conferido antes. Janela de tolerância de 5 minutos.
   - Assinatura inválida ou fora da janela → `401`, nada gravado.
   - Só o tipo `payment` é processado; os outros tipos recebem `200` e são ignorados.
   - `request_id` já registrado → `200` sem reprocessar. O registro em `payment_notifications` é gravado **na mesma transação** da transição: se a consulta ao Mercado Pago ou a transação falhar, nada é registrado, a resposta é `500` e o reenvio do Mercado Pago é processado normalmente.
   - O webhook continua sob o rate limit global. CORS não se aplica (chamada de servidor para servidor).
6. **Verificação sob demanda** (`GET /api/orders/:id/pix`, ajuste da Q11):
   - Só quando a cobrança está `PENDING` e o pedido `PENDING_PAYMENT`.
   - Limite por pedido: no máximo uma consulta ao Mercado Pago a cada **20 segundos**. A reserva da vez é atômica: `UPDATE ... SET last_checked_at = now() WHERE ... AND (last_checked_at IS NULL OR last_checked_at < now() - interval '20 seconds') RETURNING`. Só quem recebeu a linha consulta o Mercado Pago.
   - Aplica a mesma transição idempotente do webhook.
   - Falha do Mercado Pago na verificação não vira erro para a página: devolve o estado atual do banco.
   - Sem conciliação periódica em segundo plano: fica para a próxima spec.
7. **Variáveis de ambiente** (`apps/api/src/config/env.ts`, validadas com Zod): `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_NOTIFICATION_URL` (URL https). Em `NODE_ENV=production` são obrigatórias e a API não sobe sem elas. Fora de produção, se faltar qualquer uma, o Pix fica desligado e `POST /pix` responde `503 PIX_UNAVAILABLE`. O `.env.example` recebe só valores obviamente fictícios.
8. **Logs**: nunca registrar token, segredo, header de assinatura, QR code nem e-mail do cliente.

### Fase 3 — Página do pedido (Faísca, em paralelo com a Fase 2)

1. Chamadas novas em `apps/web/src/lib/api.ts`: criar e consultar a cobrança, tipadas com o contrato do shared.
2. Nova rota `apps/web/src/app/pedido/[id]/page.tsx` (Server Component) com um componente cliente para a parte interativa:
   - Ao abrir, chama `POST /pix`. Mostra o QR code (imagem a partir do base64, sem biblioteca nova), o copia e cola com botão "Copiar", o total formatado com `formatBRL` e a contagem regressiva até `expiresAt`.
   - Consulta `GET /pix` a cada 5 segundos enquanto o status for pendente. Para ao chegar em estado final ou ao vencer a contagem.
   - Estados com texto em português: aguardando pagamento, "Pagamento confirmado", pedido expirado, "Pix indisponível" (para `503`) e erro genérico.
   - A página não mostra dados pessoais além dos que o checkout já mostra hoje.
3. `checkout.tsx`: depois de criar o pedido, redireciona para `/pedido/[id]`. Sai o aviso de "Pix entra na próxima etapa". O carrinho é esvaziado como hoje.
4. Playwright: atualize `e2e/compra.spec.ts` para o novo fluxo (redireciona para a página do pedido, que mostra "Pix indisponível" no ambiente de E2E sem credenciais). Não remova verificações existentes; troque só a do aviso antigo.

## Arquivos permitidos

Forja:

- `packages/shared/src/payments.ts`, `packages/shared/src/payments.test.ts` (novos), `packages/shared/src/index.ts` (só o export)
- `docs/api/pagamentos.md` (novo)
- `apps/api/src/db/schema.ts`
- `apps/api/drizzle/0004_*.sql`, `apps/api/drizzle/0005_*.sql`, `apps/api/drizzle/meta/0004_snapshot.json`, `apps/api/drizzle/meta/0005_snapshot.json`, `apps/api/drizzle/meta/_journal.json` (só entradas novas, geradas pelo drizzle-kit)
- `apps/api/src/payments/**` (novo)
- `apps/api/src/orders/**` (só para expor ou reutilizar a transição; `lock-order.ts` sem mudança de comportamento)
- `apps/api/src/admin-orders/admin-orders.service.ts` (só para extrair a lógica de `PAID` para reuso, sem mudar comportamento)
- `apps/api/src/app.module.ts`, `apps/api/src/config/env.ts`, `apps/api/.env.example`
- `apps/api/test/payments.e2e-spec.ts` (novo), `apps/api/test/**` helpers novos se precisar
- `specs/014-pix-mercado-pago.md` (esta spec), `docs/agents/scorecard*` (registro no fechamento)

Faísca:

- `apps/web/src/app/pedido/**` (novo)
- `apps/web/src/components/checkout.tsx`, `apps/web/src/components/pedido-pix.tsx` (novo)
- `apps/web/src/lib/api.ts`
- `e2e/compra.spec.ts`
- `e2e/pedido-pix.spec.ts` (novo)

Qualquer outro caminho: pare e fale com a Bússola.

## Fora do escopo

- E-mail de confirmação, estorno automático, cartão ou outros meios, conciliação periódica em segundo plano.
- Mudar o enum `order_status`, o job de expiração ou `ORDER_HOLD_MINUTES`.
- Painel de admin (exibir pagamentos ou alertas). Os alertas ficam só no banco nesta spec.
- Deploy, credenciais reais, configuração do painel do Mercado Pago, `.github/workflows/**`.
- SDK do Mercado Pago ou qualquer dependência nova.

## Critérios de aceite

Contrato e banco:

- [ ] Commit de contrato é o primeiro da branch e contém só shared, `docs/api/pagamentos.md` e testes do shared
- [ ] Migração gerada pelo drizzle-kit, com `UNIQUE` em `provider_payment_id` e `request_id`, índice único parcial de uma `PENDING` por pedido e `CHECK`s de `provider` e `amount_cents`
- [ ] `rls.e2e-spec.ts` passa **sem alteração** (as tabelas novas têm RLS sem `FORCE`)
- [ ] `npm run db:generate -w @otilc/api` depois da mudança não cria arquivo novo

API (`apps/api/test/payments.e2e-spec.ts`, Postgres real, cliente do Mercado Pago simulado, segredo gerado no teste):

- [ ] `POST /pix` cria a cobrança com o valor do banco e `date_of_expiration` igual a `expiresAt`; segunda chamada devolve a mesma sem chamar o provedor
- [ ] Duas chamadas simultâneas de `POST /pix` para o mesmo pedido geram uma cobrança só
- [ ] `POST /pix` em pedido `PAID`, `EXPIRED` ou vencido → `409`; Pix desligado → `503`; id inválido → `400`
- [ ] Webhook com assinatura inválida, ausente ou fora da janela → `401` e nada gravado
- [ ] Webhook válido de pagamento aprovado → pedido `PAID`, `reserved` e `stock` baixam uma vez
- [ ] Mesma notificação repetida e notificações diferentes do mesmo pagamento, inclusive **simultâneas** → pedido `PAID` uma vez só, estoque baixa uma vez só
- [ ] O status do corpo da notificação é ignorado: corpo dizendo `approved` com o provedor respondendo `pending` não muda o pedido
- [ ] Falha do provedor no webhook → `500`, nada registrado em `payment_notifications`, e o reenvio processa normalmente
- [ ] Pagamento aprovado para pedido já `EXPIRED` → pedido continua `EXPIRED`, estoque intacto, `alert = PAID_AFTER_EXPIRY`
- [ ] Pedido ainda `PENDING_PAYMENT` com `expiresAt` vencido e `date_approved <= expiresAt` → `PAID`
- [ ] Valor ou referência divergente → pedido não muda, `alert = AMOUNT_MISMATCH`
- [ ] **Estresse**: webhook aprovado e job de expiração ao mesmo tempo, várias rodadas → cada pedido termina `PAID` ou `EXPIRED` (com alerta), nunca os dois, sem deadlock, estoque consistente
- [ ] `GET /pix` com cobrança pendente consulta o provedor no máximo uma vez a cada 20 s por pedido, inclusive com chamadas simultâneas; aprovado na consulta → `PAID`
- [ ] Falha do provedor no `GET /pix` → `200` com o estado do banco
- [ ] Testes unitários da verificação de assinatura (válida, inválida, tamanhos diferentes, `ts` fora da janela)
- [ ] Nenhum teste existente foi removido ou enfraquecido; `orders.e2e-spec.ts` e `admin-orders.e2e-spec.ts` passam sem alteração

Web:

- [ ] Depois do checkout, o cliente vai para `/pedido/[id]`, que mostra QR, copia e cola, total e contagem regressiva
- [ ] A página para de consultar em estado final e mostra "Pagamento confirmado" quando o pedido vira `PAID`
- [ ] Sem credenciais, a página mostra "Pix indisponível"; `npm run test:e2e:web` verde
- [ ] A contagem regressiva segue o expiresAt do pedido; ao zerar, a página para de consultar, esconde QR e copia e cola e mostra "Pedido expirado" (e2e/pedido-pix.spec.ts)

Geral:

- [ ] Nenhuma dependência nova em nenhum `package.json`
- [ ] Nenhum segredo, token ou e-mail real em código, teste, log ou commit; `.env.example` só com valores fictícios
- [ ] `git diff --name-only origin/main` só lista arquivos permitidos
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e && npm run test:e2e:web` verdes; CI verde (testes, Semgrep, gitleaks)

## Notas para o revisor

- Pagamento: revisão da Lente, segunda revisão da Faísca nas partes da Forja, e o Pedro lê o diff inteiro.
- Assinatura: confira o texto assinado contra a documentação oficial, `timingSafeEqual` com tamanho conferido e a janela de tempo. Um erro aqui deixa qualquer um marcar pedido como pago.
- Confira que o status do pagamento vem **só** da consulta ao Mercado Pago, nunca do corpo do webhook.
- Ordem de travas igual à do job de expiração e do painel. Procure caminhos que travem variantes antes do pedido.
- O registro da notificação e a transição estão na mesma transação? Uma falha no meio não pode "queimar" o `request_id`.
- A verificação sob demanda não pode virar um jeito de martelar o Mercado Pago: confira a reserva atômica de `last_checked_at`.
- Decisão derivada da Q4, tomada pela Bússola: pedido ainda `PENDING_PAYMENT` com pagamento aprovado antes de `expiresAt` vira `PAID`, mesmo que o webhook chegue depois do prazo. A reserva ainda está de pé, então o estoque fica seguro.
- Logs: nada de token, segredo, assinatura, QR ou e-mail.
