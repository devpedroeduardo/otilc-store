# spec-029 — `charged_back` na 1ª visão grava `PAYMENT_REVERSED`

- Papel: backend (pagamento) — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code)
- Depende de: spec-028 (backoff da resposta sem classificação), spec-020 (conciliação)
- Pode rodar em paralelo com: nenhuma
- Branch: `spec-029-charged-back-1a-visao`

## Objetivo

Quando a primeira resposta do Mercado Pago sobre uma cobrança local `PENDING` já vem como `charged_back/*`, a loja grava o alerta `PAYMENT_REVERSED`. Os desfechos que já existem para `charged_back`, `refunded` e `processed/partially_refunded` continuam iguais.

## Contexto

- Decisões do Pedro (2026-11-08) na nota "Grilling charged_back" do fichário "Fluxo OTILC": 12 recomendações, sem ajuste. Fatos na nota "Recon charged_back", levantados em b5a7d20 só por leitura.
- Hoje, `toChargeStatus` devolve `null` para `charged_back` (`apps/api/src/payments/mercadopago.client.ts:105-127`) e `isReversal` devolve `true` (`:130-136`). O ramo que grava `PAYMENT_REVERSED` exige cobrança `APPROVED` (`apps/api/src/payments/payment-transition.service.ts:145-161`), então a cobrança `PENDING` sai como `pending_unclassified` (`:163-167`).
- Pela spec-028, a rodada de conciliação conta essa resposta como falha (`apps/api/src/payments/payment-reconciliation.service.ts:177-188`) e na 8ª grava só `RECONCILIATION_STOPPED` (`:239-250`). Webhook, `GET /api/orders/:id/pix` e a resposta do cancelamento na expiração não gravam nada.
- Cobrança `APPROVED` + `charged_back/*` já grava `PAYMENT_REVERSED` e mantém `APPROVED` (`apps/api/test/payment-reconciliation.e2e-spec.ts:1102-1125`, `apps/api/test/admin-alerts.e2e-spec.ts:490-519`).
- Na Orders API não existe `in_mediation`: a doc de migração do MP o converte em `charged_back/in_process`. Os detalhes documentados são `in_process`, `settled` e `reimbursed`.
- O texto de `PAYMENT_REVERSED` em `packages/shared/src/alerts.ts:76-79` ("Estorno, chargeback ou mediação" / "Suspenda o envio e acompanhe a disputa no Mercado Pago.") já serve para contestação antes da aprovação. Por isso `alerts.ts` não muda (Q6).
- Pix real ainda não foi ligado: 1º deploy pendente, sem cobrança real conhecida.

## Escopo

1. Cobrança local `PENDING` + `charged_back/*` (`in_process`, `settled`, `reimbursed` ou outro detalhe) grava `PAYMENT_REVERSED` na primeira resposta, mantendo o `warn` com `status` e `status_detail`.
2. A cobrança continua `PENDING`, `approved_at` continua nulo, o pedido não é pago e o estoque não muda. `toChargeStatus` segue devolvendo `null` para `charged_back`.
3. O backoff da spec-028 não muda: a rodada de conciliação conta a resposta como falha e a 8ª grava `RECONCILIATION_STOPPED`. A Forja confere como `payments.alert` (COALESCE em `payment-reconciliation.service.ts:298-301`) fica com os dois alertas e escreve em `docs/api/pagamentos.md` o que o painel mostra.
4. A regra vale para qualquer origem: rodada de conciliação, webhook, `GET /api/orders/:id/pix` e resposta do cancelamento na expiração. Repetições seguem a regra que já vale na cobrança `APPROVED`: o alerta não duplica e, depois de resolvido, não reabre.
5. A regra vale também com o pedido `EXPIRED` ou já `PAID` por outro caminho, sem mexer em pedido nem estoque.
6. `apps/api/src/db/schema.ts:47`: só o comentário muda, para `// A conciliação fez 8 consultas seguidas sem resultado (erro ou resposta sem classificação numa cobrança PENDING) e parou (spec-020, spec-028).` Ajuste mínimo também no comentário da L45 (`PAYMENT_REVERSED`), que fala só de estorno ou contestação depois de pago e ficaria incompleto com o item 1. A Forja roda `npm run db:generate -w @otilc/api` e confirma que não sai migração.
7. `docs/api/pagamentos.md`: tabela de mapeamento (`:165`), desfechos (`:183`, `:185`), alerta `PAYMENT_REVERSED` (`:204`, que hoje diz "depois de aprovado") e resposta sem classificação (`:227`), mais o trecho que descrever a regra nova e o item 3. Ajuste mínimo também no item Reabertura (`:210`), que diz que o pagamento local segue `APPROVED` e ficaria incompleto com o item 1, sem regra nova.
8. Linha 028 do scorecard, em commit separado: copiar a linha de "Dados da linha 028 do scorecard" na nota "spec-028 R1 R2 021".

## Arquivos permitidos

- `apps/api/src/payments/payment-transition.service.ts` e a spec ao lado, se existir
- `apps/api/test/payment-reconciliation.e2e-spec.ts`, `apps/api/test/payments.e2e-spec.ts`, `apps/api/test/admin-alerts.e2e-spec.ts`, `apps/api/test/pix-setup.ts`
- `apps/api/src/db/schema.ts` (só os comentários da L45 e da L47)
- `docs/api/pagamentos.md` (só os trechos do item 7)
- `docs/agents/scorecard.md` (só a linha 028 e o realinhamento que o Prettier exigir)
- `specs/029-charged-back-1a-visao.md`

Esta spec autoriza as mudanças de contrato acima em `apps/api/src/db/schema.ts` (comentários) e `docs/api/pagamentos.md`, e nenhuma outra.

A Forja para e avisa a Bússola, sem ampliar a spec, em qualquer um destes casos:

- a correção exige enum, migração, DTO, tela, mudança de mapeamento em `mercadopago.client.ts` ou qualquer arquivo de `packages/shared`;
- o código de b5a7d20 contradiz o que está em Contexto;
- algum teste existente fora do item "Prova de aceite" precisa mudar de expectativa, ou um teste de concorrência de estoque é afetado;
- a mudança altera o tratamento de falhas reais do MP ou o backoff da spec-028.

## Fora do escopo

- Cobrança `PENDING` + `refunded/refunded`, que vira `REFUNDED` sem `PAYMENT_REVERSED`. Fica registrada como candidata a outra spec.
- Cobrança `REFUNDED` + `charged_back` (`unknown_status`, sem alerta) e o vocabulário `in_mediation` das specs 015 e 018.
- `apps/api/src/payments/mercadopago.client.ts`, `apps/api/src/payments/payment-reconciliation.service.ts`, `apps/api/src/payments/pix.service.ts`, `packages/shared/**`, `apps/api/drizzle/**`, `apps/web/**`, `.github/workflows/**`.
- Alerta novo, backfill ou script de dados.
- Deploy, segredos, painéis (Render, Vercel, Supabase, Mercado Pago) e produção, que são do Pedro. Nenhum agente consulta banco de produção.

## Prova de aceite

Os testes abaixo são escritos antes da correção, e a Forja registra na nota "spec-029 charged_back na 1ª visão" a falha deles em b5a7d20.

- (a) Cobrança `PENDING` + `charged_back/in_process`, `settled` e `reimbursed`, por conciliação, webhook e `GET /api/orders/:id/pix`: grava `PAYMENT_REVERSED` na 1ª resposta; cobrança `PENDING`, `approved_at` nulo, pedido e estoque intactos.
- (b) A 8ª rodada de conciliação ainda grava `RECONCILIATION_STOPPED`, e `check_failures` e `next_check_at` seguem a regra da spec-028.
- (c) Webhook repetido não duplica `PAYMENT_REVERSED`, e o alerta resolvido não reabre.
- (d) Pedido `EXPIRED` com cobrança `PENDING` + `charged_back`: grava `PAYMENT_REVERSED`, pedido segue `EXPIRED` e o estoque não muda.

Regressão, verde antes e depois: cobrança `APPROVED` + `charged_back/*`, `refunded` e `processed/partially_refunded` (incluindo os casos da 028), e as demais linhas da tabela `unclassified`.

## Critérios de aceite

- [ ] Provas (a) a (d) presentes e verdes, com a falha em b5a7d20 registrada na nota da spec.
- [ ] Em `apps/api/test/payment-reconciliation.e2e-spec.ts:737-787` só sai da tabela `unclassified` a linha `charged_back/in_process`, movida para um teste próprio; os testes de concorrência e os demais ficam intactos. `mercadopago.client.spec.ts` não muda.
- [ ] `npm run db:generate -w @otilc/api` não gera migração.
- [ ] `git diff main --stat` só mostra arquivos permitidos.
- [ ] Linha 028 do scorecard igual à da nota.
- [ ] Corpo do PR, corpos dos commits e texto de docs novo passaram pelo humanizer.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes; CI completo verde.

## Notas para o revisor

- Revisão da Lente, 2ª revisão da Faísca (pagamento) e o Pedro lê o diff inteiro.
- Conferir que `charged_back` em cobrança `PENDING` não paga o pedido, não muda o status da cobrança e não preenche `approved_at`.
- Conferir que o backoff da 028 e o tratamento de falhas reais do MP não mudaram.
- Conferir o que `payments.alert` mostra quando a mesma cobrança tem `PAYMENT_REVERSED` e depois `RECONCILIATION_STOPPED`.
- Nenhuma resposta real de `charged_back` foi vista no sandbox: as fixtures são simulação.
- Sem deploy no fechamento desta spec, então sem smoke test.
