# spec-018 — Painel de alertas de pagamento

- Papel: `backend` + `banco` (Forja) e `frontend` (Faísca) — ver docs/agents/roles/
- Agente sugerido: Forja (contrato, banco e API) e depois Faísca (tela), na mesma branch. Fatos e vigia do CI: Formiga. Revisão: Lente; segunda revisão: Faísca na parte da Forja (banco + pagamento). O Pedro lê o diff inteiro.
- Depende de: spec-015 (alertas), spec-020 (`RECONCILIATION_STOPPED`, `check_failures`, `next_check_at`)
- Pode rodar em paralelo com: nada que toque em `apps/api/src/payments/**`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/**`, `packages/shared/src/**` ou `apps/web/src/app/admin/**`
- Branch: `spec-018-painel-alertas`

## Objetivo

O admin vê em `/admin/alerts`, protegido pela mesma autenticação do admin, os alertas gravados em `payment_alerts` (os 5 tipos), com pedido, tipo, data e o que fazer; marca um alerta como resolvido; e, num alerta `RECONCILIATION_STOPPED`, retoma a conciliação do pagamento.

## Contexto

- Item 3 das specs candidatas da nota "spec-017 Homologação"; o botão de retomar foi adiado para cá pela spec-020 (Q5).
- Decisões do Pedro: nota "Grilling Painel de alertas" (fichário "Fluxo OTILC"), ok nas 13 recomendações, inclusive os textos da Q7.
- Fatos do código: nota "Recon Painel de alertas" (Formiga, main 2232408). Hoje `payment_alerts` não tem coluna de resolução; `recordAlert` (`payment-transition.service.ts:253-268`) faz `ON CONFLICT DO NOTHING` e preenche `payments.alert` com `COALESCE`; não há rota, schema nem DTO de alerta; última migração é a 0006. Se algum fato contradisser esta spec, pare e avise a Bússola.
- Garantias de pagamento, estoque e pedidos: README, seção "Destaques técnicos". Nada pode regredir, em especial o claim único com `SKIP LOCKED` da conciliação e os testes de concorrência.

## Como fazer

Ordem: a Forja faz as seções 1 a 5 e 8 (contrato primeiro, commitado na branch) e avisa a Bússola; depois a Faísca faz as seções 6 e 7. Fronteira: Faísca só em `apps/web/**` e `e2e/**`; Forja no resto.

### 1. Banco (Q2)

Em `payment_alerts`, migração 0007 gerada por `npm run db:generate -w @otilc/api`:

- `resolved_at timestamptz NULL`
- `resolved_by uuid NULL`, FK para a tabela de admins, `ON DELETE SET NULL`
- `CHECK (resolved_by IS NULL OR resolved_at IS NOT NULL)`
- índice parcial em `created_at` `WHERE resolved_at IS NULL`

`payments.alert` não muda: continua como histórico do primeiro alerta.

### 2. Alerta que volta (Q4)

`recordAlert` passa a reabrir um alerta resolvido: `ON CONFLICT (payment_id, alert) DO UPDATE SET resolved_at = NULL, resolved_by = NULL, created_at = now() WHERE payment_alerts.resolved_at IS NOT NULL`. Alerta aberto segue intacto (sem duplicar, sem mudar `created_at`). `payments.alert` segue com `COALESCE`.

### 3. API (Q3, Q5, Q6)

Módulo novo `apps/api/src/admin-alerts/**`, com `AdminAuthGuard` na classe e a mesma ação/papel exigida hoje para mudar o status de um pedido (OWNER e STAFF). Mutações passam pelo `AdminOriginMiddleware` (já cobre `/api/admin`). Entrada validada com `ZodValidationPipe` e schemas do shared.

- `GET /admin/alerts?situacao=abertos|resolvidos|todos&tipo=&pagina=&porPagina=` → `Paginated<AdminAlertDto>`. Padrão `abertos`, página 1, 20 por página (máx. 100), ordem `created_at desc`. Item: `id`, `type`, `createdAt`, `resolvedAt`, `resolvedBy` (nome ou e-mail do admin, ou `null`), `payment { id, providerPaymentId, status, amountCents }`, `order { id, number, status }`.
- `POST /admin/alerts/:id/resolve` → 200 com o item. `UPDATE … WHERE resolved_at IS NULL` (à prova de concorrência); já resolvido → 409 `ALERT_ALREADY_RESOLVED`; inexistente → 404.
- `POST /admin/alerts/:id/resume-reconciliation` → 200. Só para alerta `RECONCILIATION_STOPPED` cujo pagamento esteja com `check_failures >=` teto: zera `check_failures` e `next_check_at`. Não resolve o alerta. Tipo errado ou pagamento fora do teto → 409; inexistente → 404. Use a constante do teto que já existe na conciliação (não duplique o número).
- Sem reabrir manual.

### 4. Contrato no shared (Q6, Q7)

Em `packages/shared/src/` (em `admin.ts` ou num `alerts.ts` exportado pelo `index.ts`): enum dos 5 tipos espelhando o banco, schema da query, `AdminAlertDto` e o mapa puro tipo → título + orientação, com estes textos:

| Tipo                     | Título                          | O que fazer                                                                                              |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PAID_AFTER_EXPIRY`      | Pago depois do prazo            | Confira se há estoque; se houver, siga com o pedido; se não, estorne no painel do Mercado Pago.          |
| `DUPLICATE_PAYMENT`      | Pagamento em dobro              | Estorne o pagamento excedente no painel do Mercado Pago.                                                 |
| `AMOUNT_MISMATCH`        | Valor diferente do pedido       | Não envie; confira o valor no Mercado Pago e estorne ou cobre a diferença.                               |
| `PAYMENT_REVERSED`       | Estorno, chargeback ou mediação | Suspenda o envio e acompanhe a disputa no Mercado Pago.                                                  |
| `RECONCILIATION_STOPPED` | Conciliação parou               | O Mercado Pago falhou 8 vezes seguidas; confira o pagamento no painel do MP e use "Retomar conciliação". |

Um tipo sem entrada no mapa cai num texto genérico (Q1).

### 5. Docs (Q12)

- `docs/api/admin.md`: as 3 rotas (query, resposta, erros).
- `docs/api/pagamentos.md`: :146-159 cita resolução e reabertura; :175-176 cita o "Retomar conciliação".
- `README.md`: meia linha em "Destaques técnicos" e o painel no Roadmap.

### 6. Tela (Q8) — Faísca

- Página `/admin/alerts` no route group `(protected)`, Server Component, `searchParams` validados com o schema do shared: filtro Abertos/Resolvidos/Todos e por tipo, paginação.
- Tabela: data (`pt-BR`), tipo (título), pedido (link para `/admin/orders/[id]`), status e valor do pagamento (`formatBRL`), o que fazer e ações.
- Ações num client component no molde de `order-actions.tsx` (erro em estado, `router.refresh()`): "Marcar resolvido" em alertas abertos; "Retomar conciliação" em `RECONCILIATION_STOPPED`. Mensagens de 409/401 em português.
- `admin-nav.tsx`: item "Alertas (N)" com o número de abertos.
- Chamadas via `apps/web/src/lib/admin-api.ts` (e o mock em `admin-api.mock.ts`, se o modo mock exigir).

### 7. Testes da web — Faísca

- Vitest: componente de ações (sucesso, 409, 401) e filtro/página se tiver lógica.
- Playwright (`e2e/`): alerta semeado via `e2e/support/db.ts`; admin faz login, vê tipo, pedido e orientação, marca resolvido e o alerta sai de Abertos.

### 8. Scorecard (Q13) — Forja

Commit `docs(agents)` separado: só a linha 020 nova em `docs/agents/scorecard.md`, Uso/tokens = "~3% da semana (46% → 49%); em 24 h (019 + 020) ~US$ 84 equiv.: Maestro 41%, Forja 32%, Bússola 19%, Faísca 8%, Formiga 0%". A linha 015 já tem o uso; não mexa nela.

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- Forja:
  - `apps/api/src/admin-alerts/**` (novo) e `apps/api/src/app.module.ts` (registrar o módulo)
  - `apps/api/src/payments/payment-transition.service.ts` (só o `recordAlert`) e o que for preciso em `apps/api/src/payments/**` para expor a constante do teto
  - `apps/api/src/db/schema.ts` (só as colunas, CHECK, FK e índice da seção 1)
  - `apps/api/drizzle/**` (só a 0007 gerada e o meta/journal)
  - `packages/shared/src/**` (contrato da seção 4 e testes `node:test`)
  - `apps/api/test/admin-alerts.e2e-spec.ts` (novo); `apps/api/test/payment-reconciliation.e2e-spec.ts` e `apps/api/test/payments.e2e-spec.ts` só para acrescentar casos (reabertura, retomar), sem mudar asserção existente
  - `docs/api/admin.md`, `docs/api/pagamentos.md`, `README.md` (seção 5)
  - `docs/agents/scorecard.md` (linha 020)
- Faísca:
  - `apps/web/src/app/admin/(protected)/alerts/**` (novo)
  - `apps/web/src/components/admin/**`, `apps/web/src/lib/admin-api.ts`, `apps/web/src/lib/admin-api.mock.ts` e estilos do admin
  - `e2e/admin-alerts.spec.ts` (novo) e `e2e/support/**` (só helpers novos)
- Bússola: `specs/018-painel-alertas.md` (esta spec)

## Fora do escopo

- Notificação (e-mail/push) quando nasce um alerta (Q9).
- Alertas dentro do detalhe do pedido (candidata).
- Observação/texto livre na resolução; reabrir manual.
- Mudar `payments.alert`, a regra de backoff/teto, o client do MP ou `apps/api/src/admin-orders/**`.
- Deploy, `.env` real, painéis (MP, Render, Supabase). A 0007 só chega ao Supabase no 1º deploy, pelo Pedro.

## Critérios de aceite

- [ ] (e2e API) Sem sessão → 401 nas 3 rotas; mutação sem `Origin` → 403; papel sem permissão → 403.
- [ ] (e2e API) Lista filtra por situação e tipo, pagina e ordena por `created_at desc`, com pedido e pagamento no item.
- [ ] (e2e API) Resolver grava `resolved_at` e `resolved_by`; segundo resolve → 409; dois resolves simultâneos → um 200 e um 409; id inexistente → 404.
- [ ] (e2e API) Retomar zera `check_failures` e `next_check_at` e o pagamento volta a ser selecionado pela conciliação; o alerta segue aberto; 409 para outro tipo ou pagamento fora do teto.
- [ ] (e2e API) Alerta resolvido que se repete é reaberto (`resolved_at` nulo, `created_at` novo); alerta aberto que se repete não muda.
- [ ] (node:test) Mapa de orientação cobre os 5 tipos e cai no genérico; schemas da query aceitam/rejeitam o esperado.
- [ ] (Vitest) Ações: sucesso, 409 e 401.
- [ ] (Playwright) Admin vê o alerta semeado com tipo, pedido e orientação, marca resolvido e ele sai de Abertos.
- [ ] `npm run db:migrate` funciona em banco limpo e sobre um banco com a 0006.
- [ ] Testes existentes (conciliação, rodadas simultâneas, expiração, payments, admin-orders, rls, concorrência de estoque) passam sem enfraquecimento.
- [ ] Docs e scorecard (linha 020) atualizados.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e && npm run test:e2e:web` verdes; CI verde.

## Notas para o revisor

- O resolve é um `UPDATE` condicional; não pode haver resolve duplo em corrida.
- A reabertura em `recordAlert` não pode mudar o comportamento para alerta aberto nem a idempotência da transição.
- Retomar só mexe em `check_failures` e `next_check_at`; não chama o MP, não muda status de payment, pedido ou estoque.
- Rotas novas: guard, papel, CSRF por `Origin` e validação Zod em query e params.
- Textos ao usuário em português; nenhum dado de cliente além do que a tela de pedidos já mostra.
