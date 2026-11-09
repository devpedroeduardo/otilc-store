# spec-030 — Estorno parcial no formato real do Mercado Pago

- Papel: backend (pagamento) — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code)
- Depende de: spec-028 (regra de valor no estorno parcial), spec-029
- Pode rodar em paralelo com: spec-031 (que só toca `docs/homologacao-local.md`)
- Branch: `spec-030-estorno-parcial-real`

## Objetivo

Em `processed/partially_refunded`, a loja passa a exigir `total_paid_amount` igual ao total do pedido, como já faz em `accredited`. Com o formato real do MP, o estorno parcial continua deixando o pedido `PAID` com o alerta `PAYMENT_REVERSED`, e o estorno não mexe no estoque: na 1ª visão a reserva vira venda uma vez, e numa cobrança já `APPROVED` o estoque não muda. Um valor pago diferente do total cai em `AMOUNT_MISMATCH`. `recordAlert` passa a atualizar `payments.updated_at`.

## Contexto

- Decisões do Pedro (2026-11-09): nota "Triagem d-prod 021" (igualdade exata, sem ler `transactions.refunds`; tocar `updated_at`; 030 e 031 em paralelo) e nota "Grilling Estorno parcial real" (9 recomendações aceitas sem ajuste). Fatos na nota "Recon 030 031", levantados pela Formiga em fb5ccf5.
- Prova real de 2026-11-08 (d-prod da spec-021, Pix de R$ 1,00 com credencial de produção, estorno parcial de R$ 0,50 pelo painel do MP): `total_paid_amount` da order ficou em 1.00, assim como `payments[].paid_amount`. O valor devolvido só aparece em `transactions.refunds[].amount` = 0.50, com status `processed`. A order segue `processed`, o `status_detail` da order e do payment vira `partially_refunded` e o `last_updated_date` muda.
- A faixa `0 < paid <= total` da spec-028 (`apps/api/src/payments/payment-transition.service.ts:209-215`) partiu da premissa de que o MP reduz `total_paid_amount` no estorno parcial. Com o MP real ela nunca dispara. O desfecho de hoje está certo, mas a checagem de valor nesse caso é código morto e deixa passar valor pago abaixo do total.
- O parse (`apps/api/src/payments/mercadopago.client.ts:153`, `:186`) lê só `total_paid_amount` no topo. O Zod descarta `refunds[]` e `payments[].paid_amount` porque o schema não usa `.strict()`, então a fixture real passa sem mudar o schema.
- A regra da 028 só tem teste no e2e, em `apps/api/test/payment-reconciliation.e2e-spec.ts:1889-2047`: fixture com valor reduzido (`:1895`, hoje espera `PAID`) e com zero (`:1977`, espera `AMOUNT_MISMATCH`). O unit cobre só o parse (`mercadopago.client.spec.ts:189-217`) e o mapeamento (`:442`).
- `payments.updated_at` não tem leitor na API, na loja, no painel, na conciliação nem nos testes. Hoje é escrito só em `payment-transition.service.ts:151`, `:200` e `:243`. `recordAlert` (`:308-311`) atualiza só `alert`, e só quando o insert em `payment_alerts` passa; alerta repetido retorna antes, em `:307`.
- Webhook real: a query traz `data.external_reference` além de `data.id` e `type=order`. A validação aceita e descarta o campo (`packages/shared`, `:93-96`; pipe `:4-20`). O id de produção `ORD01...` passa em `^ORD[0-9A-Z]{26,40}$`. O MP mandou 2 notificações para o mesmo pagamento (criação e pagamento), as duas responderam 200 e nenhuma teve efeito duplicado. Nada disso pede mudança de código.

## Escopo

1. Regra de valor (Q1, Triagem): em `processed/partially_refunded`, `paidMatches` exige `remote.paidAmountCents === order.totalCents`, igual a `accredited`. A loja não lê `transactions.refunds`. `remote.paidAmountCents === null` continua passando (Q4); fica registrado como limite.
2. Comentário de `payment-transition.service.ts:209-210` reescrito para a regra nova, citando a prova real de 2026-11-08 (Q7). O de `:270-271` (data do estorno como `approvedAt`) continua verdadeiro e não muda.
3. `recordAlert` grava `updatedAt: new Date()` no mesmo `update` que grava `alert` (Q5). Toca sempre que esse `update` roda, inclusive quando o `COALESCE` mantém o alerta anterior e na reabertura (`reopen`). Alerta repetido, que retorna em `:307`, não toca.
4. `docs/api/pagamentos.md` (Q8): a regra de valor com o formato real do estorno parcial (`total_paid_amount` fica no total, o devolvido só aparece em `transactions.refunds[]`, `status_detail` `partially_refunded` na order e no payment); o webhook com `data.external_reference` na query, aceito e ignorado, `data.id` `ORD...` e `type=order`; as 2 notificações por pagamento (criação e pagamento) sem efeito duplicado; o formato dos ids de produção (`ORD01...`, `PAY01...`). Trechos: `:124-155`, `:163-228`, `:205` e `:382`.
5. Linha 029 do scorecard, em commit separado: os dados e o uso (~3% da semana) estão na nota "spec-029 charged_back na 1ª visão".

## Arquivos permitidos

- `apps/api/src/payments/payment-transition.service.ts` e a spec ao lado, se existir
- `apps/api/src/payments/mercadopago.client.spec.ts` (só o teste de parse do item (c) da Prova de aceite)
- `apps/api/test/payment-reconciliation.e2e-spec.ts`, `apps/api/test/payments.e2e-spec.ts`, `apps/api/test/admin-alerts.e2e-spec.ts`, `apps/api/test/pix-setup.ts`
- `docs/api/pagamentos.md` (só os trechos do item 4)
- `docs/agents/scorecard.md` (só a linha 029 e o realinhamento que o Prettier exigir)
- `specs/030-estorno-parcial-real.md`

Esta spec autoriza a mudança de contrato em `docs/api/pagamentos.md` descrita no item 4, e nenhuma outra.

A Forja para e avisa a Bússola, sem ampliar a spec, em qualquer um destes casos:

- a mudança exige alterar `mercadopago.client.ts`, o schema Zod do MP, `packages/shared`, `schema.ts`, migração, DTO ou tela;
- o código de fb5ccf5 contradiz o que está em Contexto;
- algum teste existente fora da Prova de aceite precisa mudar de expectativa, ou um teste de concorrência de estoque é afetado;
- a mudança altera o backoff da spec-028 ou os desfechos da spec-029.

## Fora do escopo

- Ler ou guardar o valor devolvido (`transactions.refunds`).
- Mudar o tratamento de `paidAmountCents === null`.
- Mudar a validação do webhook ou o formato aceito de id.
- `docs/homologacao-local.md` (é da spec-031), `apps/api/src/payments/mercadopago.client.ts`, `apps/api/src/payments/payment-reconciliation.service.ts`, `apps/api/src/payments/pix.service.ts`, `packages/shared/**`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/**`, `apps/web/**`, `.github/workflows/**`.
- Backfill ou script de dados.
- Deploy, segredos, `.env` real e painéis (Mercado Pago, Render, Vercel, Supabase), que são do Pedro. Os testes usam o MP mockado; nenhum agente chama o MP de verdade nem consulta banco de produção.

## Prova de aceite

Os testes (b) e (d) são escritos antes da correção, e a Forja registra na nota "spec-030 Estorno parcial real" o resultado deles em fb5ccf5: só a (b) e o caso de 1 centavo falham na main; a (d) passa, porque a faixa da spec-028 já recusava valor acima do total.

- (a) Fixture no formato real (Q2): `processed/partially_refunded` na order e no payment, `total_paid_amount` e `payments[].paid_amount` iguais ao total, `transactions.refunds[]` com `amount` 0.50 e status `processed`, `last_updated_date` posterior à aprovação. No e2e, tanto na 1ª visão quanto na passagem de uma cobrança já `APPROVED`: pedido `PAID` e alerta `PAYMENT_REVERSED`. O estorno não mexe no estoque: na 1ª visão, o estoque baixa uma vez pela venda (a reserva vira venda); numa cobrança já `APPROVED`, ele fica intacto.
- (b) O teste de valor reduzido (`payment-reconciliation.e2e-spec.ts:1901`) passa a usar o valor reduzido como override explícito (total - 100) e muda de expectativa no mesmo teste, de `PAID` para `AMOUNT_MISMATCH`, com nome que diga isso (Q1). A fixture `partialRefund` (`:1891-1899`) passa ao formato real (valor pago igual ao total), e os testes de `:1917`, `:1934` e `:1953` mantêm as expectativas. O caso "de 1 centavo" sai do `it.each` "continua pagando" e passa a esperar `AMOUNT_MISMATCH`, pelo mesmo endurecimento. São os testes que falham em fb5ccf5. O PR explica que a mudança endurece a regra. O caso zero (`:1977`) fica como está. Desvio autorizado pela Bússola em 2026-11-09.
- (c) Unit de parse: a resposta com `transactions.refunds[]` e `payments[].paid_amount` é lida sem erro e `paidAmountCents` vem de `total_paid_amount` (Q2).
- (d) Valor pago acima do total em `partially_refunded` dá `AMOUNT_MISMATCH`, num caso curto (Q3): o teste que já existe em `:2007`, renomeado citando a spec-030. Ele passa em fb5ccf5.
- (e) `updated_at` (Q6), em e2e: depois da aprovação, um alerta gravado em outra sincronização deixa `payments.updated_at` maior que o horário da aprovação; alerta repetido não muda `updated_at`.

Regressão, verde antes e depois: `accredited` com valor exato e divergente, `refunded`, `charged_back` (incluindo a 029), o backoff da 028 e os testes de concorrência de estoque.

## Critérios de aceite

- [ ] Provas (a) a (e) presentes e verdes, com o resultado em fb5ccf5 registrado na nota da spec: falham a (b) e o caso de 1 centavo, e a (d) passa.
- [ ] Nenhum teste existente fora da Prova de aceite mudou de expectativa; testes de concorrência intactos.
- [ ] `npm run db:generate -w @otilc/api` não gera migração.
- [ ] `git diff main --stat` só mostra arquivos permitidos.
- [ ] Linha 029 do scorecard igual à nota "spec-029 charged_back na 1ª visão".
- [ ] Corpo do PR, corpos dos commits, comentários novos com mais de uma frase e texto novo de docs passaram pelo humanizer.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes; CI completo verde.

## Notas para o revisor

- Revisão da Lente e 2ª revisão da Faísca (pagamento).
- Conferir que `partially_refunded` com valor pago igual ao total segue `PAID` + `PAYMENT_REVERSED` sem mexer no estoque, e que valor diferente dá `AMOUNT_MISMATCH`.
- Conferir que `recordAlert` só toca `updated_at` quando grava o alerta.
- A fixture (a) reproduz o formato visto em produção em 2026-11-08; a de (b) e (d) continua sendo simulação.
- Sem deploy no fechamento desta spec, então sem smoke test.
