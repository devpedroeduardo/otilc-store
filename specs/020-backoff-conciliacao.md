# spec-020 — Teto e backoff na conciliação Pix

- Papel: `backend` + `banco` (Forja) — ver docs/agents/roles/
- Agente sugerido: Forja (só implementa). Fatos e vigia do CI: Formiga. Revisão: Lente; segunda revisão: Faísca (banco + pagamento). O Pedro lê o diff inteiro.
- Depende de: spec-015 (conciliação), spec-019 (cancelamento do Pix pelo admin)
- Pode rodar em paralelo com: nada que toque em `apps/api/src/payments/**`, `apps/api/src/db/schema.ts` ou `apps/api/drizzle/**`
- Branch: `spec-020-backoff-conciliacao`

## Objetivo

Um pagamento cuja consulta ao Mercado Pago (MP) falha sempre (ex.: 404) deixa de ser consultado a cada rodada: as tentativas se espaçam com backoff exponencial e, ao atingir o teto de falhas consecutivas, a conciliação para de consultá-lo e grava um alerta `RECONCILIATION_STOPPED` em `payment_alerts` (que o painel da spec-018 vai mostrar).

## Contexto

- Achado 4 da homologação (nota "spec-017 Homologação") e ressalva da 015 (nota "spec-015 Conciliação Pix"): um Pix que dá 404 é consultado em toda rodada por 24 h (~288 consultas no intervalo padrão de 300 s, ~2.876 com 30 s), volta sempre ao topo do lote e, com 50 ou mais falhando, monopoliza a rodada.
- Decisões do Pedro: nota "Grilling Backoff conciliação" (fichário "Fluxo OTILC"), ok nas 15 recomendações (Q1 = A).
- Fatos do código: nota "Recon Backoff conciliação" (Formiga, main 28fc0fb). Hoje qualquer erro do MP vira `warn` + release (`last_checked_at` volta ao valor anterior); `PixProviderError` não carrega o status HTTP; `payments` não tem coluna de tentativas nem de próxima consulta; última migração é a 0005. Se algum fato contradisser esta spec, pare e avise a Bússola.
- Contrato atual: `docs/api/pagamentos.md` (conciliação em :161-179). Garantias de pagamento, estoque e pedidos: README, seção "Destaques técnicos". Nada disso pode regredir, em especial o claim único com `SKIP LOCKED` e os testes de rodadas simultâneas.

## Como fazer

### 1. Quais falhas contam (Q1 = A)

Toda falha da consulta ao MP conta igual (404, 5xx, rede, timeout). O `PixProviderError` não muda.

### 2. Estado no banco (Q3)

Em `payments`, duas colunas novas:

- `check_failures integer NOT NULL DEFAULT 0` com `CHECK (check_failures >= 0)`
- `next_check_at timestamptz NULL`

Migração gerada por `npm run db:generate -w @otilc/api` (0006), commitada. Sem tabela nova.

### 3. Backoff e teto (Q2, Q5)

- Constantes no código (sem env nova): teto = **8 falhas consecutivas**; limite do atraso = **1 h**.
- Após a n-ésima falha consecutiva (n < 8): `check_failures = n` e `next_check_at = now() + min(intervalo da rodada × 2^(n−1), 1 h)`. No padrão de 300 s: 5, 10, 20, 40, 60, 60, 60 min.
- O cálculo do atraso é uma função pura, com teste unitário.
- O claim da rodada passa a ignorar payments com `next_check_at > now()` e com `check_failures >= 8`, mantendo o `UPDATE … FROM (… SKIP LOCKED LIMIT)` e as janelas atuais (PENDING 2 min–24 h, APPROVED 7 dias a cada 6 h, nada com menos de 20 s).
- Na 8ª falha consecutiva: `check_failures = 8`, grava o alerta `RECONCILIATION_STOPPED` via `recordAlert` (uma única vez; o `UNIQUE(payment_id, alert)` garante) e o payment não é mais consultado pela conciliação. O status do payment **não** muda (segue `PENDING` ou `APPROVED`); o pedido e o estoque não mudam.
- Vale igual para os `APPROVED` da verificação de estorno (Q7).
- Retomar a consulta de um payment no teto é da spec-018 (fora desta).

### 4. Sucesso zera (Q6)

- Consulta bem-sucedida da conciliação: `check_failures = 0`, `next_check_at = NULL`.
- Webhook que aplica um status do MP com sucesso também zera, inclusive para um payment no teto (ele volta ao fluxo normal). O alerta já gravado fica como histórico.

### 5. Alerta novo (Q4)

- Valor novo `RECONCILIATION_STOPPED` no enum `paymentAlert` (`schema.ts` + migração).
- Atenção: `ALTER TYPE … ADD VALUE` não pode ser usado na mesma transação em que é criado. Confira como o migrator do Drizzle aplica a 0006 e garanta que `db:migrate` em banco limpo e em banco existente funcionam.
- `packages/shared` não muda (o DTO de alerta é da 018).

### 6. Logs (Q9)

`warn` em cada falha com id do payment, contador e próxima consulta; `error` uma vez ao atingir o teto. Sem token nem dados do cliente.

### 7. Docs e caronas (Q11, Q12, Q13, Q15)

- `docs/api/pagamentos.md` (seção de conciliação): backoff, teto, o alerta `RECONCILIATION_STOPPED` na lista de alertas, zerar no sucesso e no webhook.
- Carona S3 da 019: `pagamentos.md` já cita `ORDER_NOT_PAYABLE` (:24/:77). Confira se o caso "o pedido sai de `PENDING_PAYMENT` durante a criação do Pix" está descrito; se não, uma frase no mesmo trecho.
- `README.md`: meia linha em "Destaques técnicos" (:59) sobre o teto/backoff.
- Carona S2 da 019 **não** entra (decisão do Pedro na Q12): `admin-orders/**` fica intocado.
- Scorecard (commit `docs(agents)` separado): linha 015, coluna Uso/tokens = "~8% da semana (registrado no fechamento, PR #27)"; linha 019 nova = "~5% da semana (41% → 46%); em 24 h ~US$ 88 equiv. no time: Maestro 41%, Forja 31%, Bússola 21%, Faísca 8%; primeira spec com a Formiga no OpenCode big-pickle (0% do plano)", rodadas: 1 de correção (corrida do createCharge, fdd25a1).

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- `apps/api/src/payments/**` (conciliação, transição, webhook, specs unitários)
- `apps/api/src/db/schema.ts` (só as duas colunas, o CHECK e o valor novo do enum)
- `apps/api/drizzle/**` (só a migração nova 0006 gerada e o meta/journal que o `db:generate` atualiza)
- `apps/api/test/payment-reconciliation.e2e-spec.ts`, `apps/api/test/pix-setup.ts`
- `apps/api/test/payments.e2e-spec.ts`: só para acrescentar casos novos (webhook zera o contador), sem mudar asserção existente
- `docs/api/pagamentos.md`, `README.md` (só o descrito na seção 7)
- `docs/agents/scorecard.md` (linhas 015 e 019)
- `specs/020-backoff-conciliacao.md` (esta spec)

## Fora do escopo

- `packages/shared/src/**`, `apps/api/src/admin-orders/**`, `apps/web/**`.
- Distinguir 404 de 5xx no client (Q1 = B, descartada).
- Retry do PUT de cancelamento na expiração (segue só log; ressalva registrada).
- Botão ou endpoint para retomar a consulta, painel de alertas (spec-018), migração para a API de Orders.
- Env nova ou mudança no intervalo da rodada, no tamanho do lote ou nas janelas.
- Credenciais reais do MP e rede em teste: o MP é sempre mockado (`test/pix-setup.ts`). Nenhum agente toca `.env` real.

## Critérios de aceite

- [ ] (e2e) Falha na consulta: `check_failures = 1`, `next_check_at` ≈ now() + intervalo; o payment não é consultado de novo numa rodada antes desse horário.
- [ ] (e2e) Retrodatando `next_check_at` via SQL, o payment volta a ser consultado.
- [ ] (unit) A função de atraso dobra a cada falha e satura em 1 h.
- [ ] (e2e) Na 8ª falha consecutiva: exatamente 1 alerta `RECONCILIATION_STOPPED`; o payment não é consultado em rodadas seguintes; status do payment, pedido e estoque intactos.
- [ ] (e2e) Consulta bem-sucedida depois de falhas zera `check_failures` e `next_check_at`.
- [ ] (e2e) Webhook que aplica status do MP a um payment no teto aplica o status e zera o contador.
- [ ] (e2e) Com 50 payments falhando de forma permanente, um payment saudável ainda é consultado na mesma rodada ou na seguinte (ressalva da 015).
- [ ] (e2e) A regra vale para `APPROVED` na verificação de estorno.
- [ ] Testes existentes de conciliação, rodadas simultâneas, expiração, payments, admin-orders e rls passam sem enfraquecimento. Nenhuma asserção existente muda; se algum teste precisar de ajuste de montagem, explique no PR.
- [ ] `npm run db:migrate` funciona em banco limpo e sobre um banco com a 0005 aplicada.
- [ ] `docs/api/pagamentos.md`, `README.md` e scorecard (linhas 015 e 019) atualizados.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes; `npm run test:e2e:web` verde.

## Notas para o revisor

- O claim continua único e com `SKIP LOCKED`; o filtro novo não pode reabrir consulta dupla entre rodadas simultâneas.
- Nenhuma chamada ao MP com transação ou trava aberta.
- A migração do enum (`ADD VALUE`) e a aplicação em produção (Supabase) só acontecem no deploy do Pedro.
- No teto, só a conciliação para: webhook, expiração e cancelamento pelo admin seguem iguais.
- Logs sem token, e-mail ou telefone do cliente.
