# spec-025 — E2E web do admin isolado

- Papel: frontend (testes E2E) — ver docs/agents/roles/
- Agente sugerido: Faísca (Claude Code)
- Depende de: nenhuma
- Pode rodar em paralelo com: nenhuma (a spec-026 só começa depois do merge desta)
- Branch: `spec-025-e2e-admin-isolado`

## Objetivo

A suíte E2E web (`npm run test:e2e:web`) passa inteira duas vezes seguidas no ambiente local. Cada arquivo de teste devolve ao estado inicial o estoque que reservou. Nenhum código de produção muda.

## Contexto

- Decisões do Pedro (2026-11-02) na nota "Grilling E2E admin" do fichário "Fluxo OTILC", 10 respostas. Fatos na nota "Recon E2E admin" (main 7be8ddb).
- `e2e/admin.spec.ts:99` falha quando roda depois de `e2e/admin-alerts.spec.ts`. Sozinho, passa (5/5). A falha é determinística.
- Causa: `e2e/admin-alerts.spec.ts:9` cria um pedido do `12-casaco` e não o cancela, então a unidade fica reservada até o fim da execução. A grade põe os esgotados no fim e desempata por `createdAt` desc (`apps/api/src/catalog/catalog.service.ts:49-68`). Pelo seed (`apps/api/src/db/seed.ts:87`) o `11-short` é mais novo que o `12-casaco`, e o casaco reservado vira o último card no lugar do `11-short`.
- `e2e/compra.spec.ts:4` deixa o `05-camiseta-preta` reservado do mesmo jeito. Hoje não quebra nenhum teste, mas entra na correção.
- `e2e/admin.spec.ts:79` já usa o `13-corta-vento` e cancela o pedido no fim; serve de referência.
- O Playwright roda com 1 worker, sem paralelismo e sem retries (`playwright.config.ts:22-25`). O `e2e/global-setup.ts:15-18` migra, semeia e limpa alertas, sessões e admins uma vez por execução. Não existe limpeza entre arquivos nem helper para cancelar pedido.
- Helpers existentes: `createOrder` e `loginAs` (`e2e/support/flows.ts`), `variantOf`, `seedAlert` e `alertResolved` (`e2e/support/db.ts`).
- Nenhum workflow roda `test:e2e:web` (`.github/workflows/ci.yml:52` roda só o E2E da API). O CI verde desta spec não cobre a suíte web; por isso a prova são as execuções locais. Levar a suíte para o CI fica para outra spec.

## Escopo

1. Um helper em `e2e/support/` que cancela o pedido criado pelo teste e devolve a reserva. Pode usar o mesmo caminho do `admin.spec.ts:79` ou SQL de teste em `e2e/support/db.ts` (template `sql` ou query parametrizada, nunca concatenação).
2. `e2e/admin-alerts.spec.ts` chama o helper em `afterEach` ou `afterAll`, para limpar mesmo se o teste falhar no meio.
3. `e2e/compra.spec.ts` faz o mesmo com o pedido do `05-camiseta-preta`.
4. Linha 024 do scorecard, copiada da nota "spec-024 Humanizer no README e docs" (uso "não informado"), em commit separado.

## Arquivos permitidos

- `e2e/**` (specs e `support/`), fora `e2e/global-setup.ts`
- `docs/agents/scorecard.md` (só a linha 024)

Se for preciso mexer em `playwright.config.ts`, `e2e/global-setup.ts`, no seed ou em código de produção, a Faísca para e avisa a Bússola.

## Fora do escopo

- Código de produção (`apps/**`, `packages/**`), seed e migrações.
- `playwright.config.ts` e `e2e/global-setup.ts`: nada de reset do banco por arquivo ou por teste.
- Afrouxar a asserção de `e2e/admin.spec.ts:99`. Ela testa a regra "esgotado vai para o fim" e foi o teste que pegou o vazamento.
- Trocar o produto do `admin-alerts.spec.ts` por outro do seed.
- `.github/workflows/**` e a entrada da suíte web no CI.

## Critérios de aceite

- [ ] `npm run test:e2e:web` passa duas vezes seguidas, sem nada entre as execuções. A Formiga roda e anexa o resumo ao PR.
- [ ] `npx playwright test admin-alerts.spec.ts admin.spec.ts` passa, e cada arquivo de `e2e/*.spec.ts` passa com `--repeat-each=2` (Formiga).
- [ ] Depois de uma execução completa, nenhum produto fica com unidade reservada por pedido criado na suíte (a Formiga confere no `otilc_test_e2e`).
- [ ] `e2e/admin.spec.ts` não muda nas asserções.
- [ ] `git diff main --stat` só mostra arquivos permitidos; diff do scorecard = +1 linha (a 024).
- [ ] Corpo do PR e corpos dos commits passaram pelo humanizer.
- [ ] `npm run format:check && npm run typecheck && npm test` verdes; CI verde.

## Notas para o revisor

- Conferir que a limpeza roda mesmo com o teste falhando (hook, não fim do teste).
- Conferir que o helper só toca pedidos criados pelo próprio teste, e não pedidos do seed.
- SQL no helper: parametrizado, sem concatenação de string.
