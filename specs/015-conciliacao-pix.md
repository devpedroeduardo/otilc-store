# spec-015 — Conciliação periódica do Pix e cancelamento no Mercado Pago do Pix expirado

- Papel: `backend` + `seguranca` (Forja) — ver docs/agents/roles/
- Agente sugerido: Forja (contrato, banco, API). Revisão: Lente; segunda revisão: Faísca (pagamento); uma passada focada do especialista Payments & Billing Engineer (conciliação e idempotência). O Pedro lê o diff inteiro.
- Depende de: spec-014 (mergeada em 05c9c9e)
- Pode rodar em paralelo com: nada que toque em `apps/api/src/payments/**`, `apps/api/src/orders/**`, `apps/api/src/db/schema.ts` ou `apps/api/drizzle/**`
- Branch: `spec-015-conciliacao-pix`

## Objetivo

A API confere sozinha, a cada 5 minutos, os pagamentos Pix com o Mercado Pago (MP) e corrige o estado local quando o webhook e a verificação sob demanda falharam. Quando um pedido expira, o Pix dele é cancelado no MP. As três ressalvas abertas da spec-014 que tocam a API ficam resolvidas: aprovação sem `date_approved`, alertas sem rastro operacional e webhook sob o limite global de requisições.

## Contexto

- Decisões do Pedro: nota "Grilling Conciliação" (fichário "Fluxo OTILC"), sim para as 8 recomendações. A API fica no plano pago do Render, sem hibernação: o timer dentro da API é o mecanismo principal.
- Fatos do código: nota "Recon Conciliação".
- Contrato atual dos pagamentos: `docs/api/pagamentos.md`. Garantias de estoque e pedidos: README, seção "Destaques técnicos". Nada disso pode regredir.
- `PaymentTransitionService.sync()` já é a única porta de transição (trava `orders` e depois `payments` com `FOR UPDATE`, é idempotente e grava os alertas). A conciliação e o cancelamento **reusam** o `sync()`; não criam outro caminho de transição.
- O padrão de job do repositório é `setInterval` com `unref()` em `OnModuleInit`, como `OrderExpirationService`. Não há `@nestjs/schedule` e não entra dependência nova.

## Como fazer

### 1. Conciliação periódica (Q1, Q2, Q3)

- Novo serviço de job em `apps/api/src/payments/` no padrão de `OrderExpirationService` (timer com `unref`, para no `OnApplicationShutdown`, erro vai para o log e não derruba a API).
- Intervalo: `PAYMENT_RECONCILIATION_INTERVAL_MS`, padrão `300000` (5 min), validado com Zod em `env.ts` e documentado no `.env.example`. Os testes chamam o método da rodada direto; o timer não pode interferir nos e2e (siga o que já é feito para a expiração).
- Seleção por rodada, no máximo `50` pagamentos (constante), em ordem de `last_checked_at` com nulos primeiro:
  - `PENDING` criados há mais de 2 min e há menos de 24 h;
  - `APPROVED` com `approved_at` nos últimos 7 dias e `last_checked_at` nulo ou com mais de 6 h (para pegar estorno e contestação, item 3e). Decisão derivada da Bússola; o Pedro pode mudar.
  - Respeita a verificação sob demanda: não pega pagamento com `last_checked_at` mais recente que 20 s.
- Reivindicação à prova de várias instâncias: num único comando, selecionar com `FOR UPDATE SKIP LOCKED` e gravar `last_checked_at = now()`, e só então, **fora da transação**, consultar o MP (`getPayment`) e chamar `sync()`. Nenhuma chamada ao MP com trava de banco aberta.
- Erro ou 404 do MP num pagamento: log com o id do pagamento e segue para o próximo; a próxima rodada tenta de novo (3f). Um erro não interrompe a rodada.
- Divergências (3a a 3d) seguem o que o `sync()` já faz: aprovado no prazo vira `PAID`; aprovado depois do prazo vira `PAID_AFTER_EXPIRY`; aprovado com pedido já pago vira `DUPLICATE_PAYMENT`; cancelado, rejeitado ou expirado no MP atualiza `payments.status` e o pedido segue a própria expiração.
- Índice para a varredura em `payments` (por exemplo `(status, last_checked_at)`), se o plano do Postgres pedir. Justifique no PR.

### 2. Estorno ou contestação depois de pago (3e)

- Novo valor `PAYMENT_REVERSED` no enum `payment_alert` (migração `0005_*`, gerada pelo drizzle-kit).
- Pagamento local `APPROVED` cujo status remoto é `refunded`, `charged_back` ou `in_mediation`: grava `alert = 'PAYMENT_REVERSED'` e, para `refunded`, `payments.status = 'REFUNDED'`. O pedido **não** muda. Se já havia outro alerta, o novo prevalece e o anterior vai para o log.
- Isso vale para qualquer origem do `sync()` (conciliação, webhook ou verificação sob demanda), e é idempotente: repetir a mesma notificação não gera log nem escrita novos.

### 3. Cancelar o Pix no MP quando o pedido expira (Q4)

- Novo `cancelPayment(id)` no cliente do MP e na interface `PixProvider`: `PUT /v1/payments/:id` com `{ "status": "cancelled" }`, mesmo timeout, resposta validada com Zod.
- `releaseExpired()` passa a informar os pedidos que expirou (ou os pagamentos `PENDING` deles). **Depois do commit**, o job de expiração chama `cancelPayment` para cada Pix pendente desses pedidos e, em seguida, `sync()` com a resposta, fora de qualquer transação.
- Falha no cancelamento: log e segue; a conciliação pega o pagamento na janela de 24 h. Se o MP responder que o Pix já estava aprovado, o `sync()` aplica `PAID_AFTER_EXPIRY` como hoje.
- A expiração de reservas (estoque devolvido, `SKIP LOCKED`, sem deadlock) não pode mudar de comportamento. Os testes de concorrência existentes continuam intactos.

### 4. Aprovação sem `date_approved` (Q5)

- O schema da resposta do MP passa a ler `date_last_updated`. O momento da aprovação é `date_approved`, senão `date_last_updated`, senão `now()`. Os dois últimos casos geram `warn` no log com o id do pagamento.

### 5. Alertas com rastro no log (Q6)

- Todo alerta gravado gera um `warn` com id do pagamento, id do pedido e o alerta. Sem dados do cliente, sem token. O painel de alertas fica para a spec-016.

### 6. Limite próprio do webhook (Q7)

- `POST /api/webhooks/mercadopago` ganha limite próprio de 600 requisições por minuto por IP (via `@Throttle` do `@nestjs/throttler`, que já existe). O resto da API mantém 120/min.

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- `apps/api/src/db/schema.ts` (valor novo do enum e índice, se houver)
- `apps/api/drizzle/0005_*.sql`, `apps/api/drizzle/meta/0005_snapshot.json`, `apps/api/drizzle/meta/_journal.json` (só a entrada nova, gerados pelo drizzle-kit)
- `apps/api/src/payments/**`
- `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/order-expiration.service.ts`, `apps/api/src/orders/orders.module.ts` (só para devolver os pedidos expirados e disparar o cancelamento; `lock-order.ts` e `order-stock.ts` sem mudança)
- `apps/api/src/config/env.ts`, `apps/api/src/config/env.spec.ts`, `apps/api/.env.example`
- `apps/api/test/payments.e2e-spec.ts`, `apps/api/test/payment-reconciliation.e2e-spec.ts` (novo), `apps/api/test/pix-setup.ts`
- `docs/api/pagamentos.md` (contrato: alerta novo, cancelamento, conciliação, limite do webhook)
- `README.md` (só a seção "Destaques técnicos", se descrever a conciliação)
- `specs/015-conciliacao-pix.md` (esta spec), `docs/agents/scorecard.md` (fechamento)

## Fora do escopo

- Painel ou endpoint de leitura de alertas (spec-016, Faísca).
- Estorno automático no MP. O estorno continua manual.
- Mudança em `packages/shared/src/**`: o alerta não é exposto pela API pública. Se precisar, pare e reporte.
- Mudar a validade do Pix (31 min) ou o prazo do pedido (30 min).
- `@nestjs/schedule`, pg_cron, worker separado ou qualquer dependência nova.
- Config de deploy (`render.yaml`, Dockerfile, workflows).
- Credenciais reais do MP: nada de token, segredo ou chamada ao sandbox real em teste. O MP é sempre mockado.

## Critérios de aceite

- [ ] Rodada de conciliação (e2e): pagamento `PENDING` com MP `approved` dentro do prazo vira `PAID` e baixa o estoque uma vez só.
- [ ] Rodada de conciliação (e2e): MP `approved` depois do prazo resulta em `PAID_AFTER_EXPIRY`; pedido já pago resulta em `DUPLICATE_PAYMENT`; MP `cancelled` ou `rejected` atualiza `payments.status` sem mudar o pedido.
- [ ] Seleção (e2e): não pega pendente com menos de 2 min nem com mais de 24 h, nem pagamento checado há menos de 20 s; respeita o limite de 50; `APPROVED` com mais de 7 dias fica fora.
- [ ] Concorrência (e2e): duas rodadas simultâneas não consultam o MP duas vezes pelo mesmo pagamento (contagem de chamadas do mock).
- [ ] Erro do MP num pagamento não interrompe a rodada; os outros são conciliados (e2e).
- [ ] Rodar a mesma rodada duas vezes não muda nada na segunda (idempotência, e2e).
- [ ] `PAYMENT_REVERSED`: pagamento `APPROVED` com MP `refunded`, `charged_back` ou `in_mediation` grava o alerta, `refunded` vira `REFUNDED`, e o pedido não muda (e2e).
- [ ] Expiração (e2e): pedido expirado com Pix pendente tem `cancelPayment` chamado depois do commit e o pagamento fica `CANCELLED`; falha no cancelamento não impede a devolução do estoque; MP respondendo `approved` no cancelamento resulta em `PAID_AFTER_EXPIRY`.
- [ ] `cancelPayment` (unit): método, caminho e corpo corretos, timeout, resposta validada com Zod.
- [ ] Aprovação sem `date_approved` usa `date_last_updated` e, sem os dois, `now()`, com `warn` no log (unit ou e2e).
- [ ] Todo alerta gravado gera `warn` sem dados do cliente (unit ou e2e).
- [ ] Webhook (e2e): 130 requisições seguidas do mesmo IP não recebem `429`; outra rota continua com o limite de 120/min.
- [ ] `PAYMENT_RECONCILIATION_INTERVAL_MS` validado em `env.ts`, com teste em `env.spec.ts` e linha no `.env.example`.
- [ ] Testes existentes de orders, admin-orders, payments e rls passam sem enfraquecimento.
- [ ] `npm run db:generate -w @otilc/api` não gera nada além da `0005` commitada.
- [ ] `docs/api/pagamentos.md` descreve o alerta novo, o cancelamento, a conciliação e o limite do webhook.
- [ ] Scorecard: linha da 015 e a coluna Uso/tokens da 014 preenchida com "~10% da semana (13% → 23%), janela de 5h estourou 1x na build (retomou 15:40); sessão em 46% às ~19h de 2026-10-28, incluindo a instalação do graphify e dos especialistas".
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes; `npm run test:e2e:web` verde.

## Notas para o revisor

- Nenhuma chamada ao MP com transação ou trava aberta (conciliação e cancelamento).
- A reivindicação com `SKIP LOCKED` + `last_checked_at` é o que impede duas instâncias de processar o mesmo pagamento. Confira o teste de concorrência.
- `releaseExpired()` mudou de assinatura: confira que a devolução de estoque e a ordem das travas são as mesmas (spec-008).
- `PAYMENT_REVERSED` sobrescreve um alerta anterior: confira que o anterior vai para o log.
- Limite do webhook: 600/min por IP é folga para rajadas do MP, não ausência de limite. A assinatura continua barrando requisições forjadas.
