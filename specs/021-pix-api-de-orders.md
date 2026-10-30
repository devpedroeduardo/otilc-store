# spec-021 — Migrar o Pix de /v1/payments para a API de Orders do Mercado Pago

- Papel: `backend` + `seguranca` (Forja) — ver docs/agents/roles/
- Agente sugerido: Forja (implementa código, roteiro e scorecard). Fatos e vigia do CI: Formiga. Revisão: Lente; segunda revisão: Faísca (pagamento). O Pedro lê o diff inteiro.
- Depende de: spec-014/015 (Pix e conciliação), spec-018 (alertas), spec-019 (cancelar Pix), spec-020 (teto/backoff)
- Pode rodar em paralelo com: nada que toque em `apps/api/src/payments/**`
- Branch: `spec-021-orders-pix`

## Objetivo

Toda a integração do Pix com o Mercado Pago (MP) usa a API de Orders (`/v1/orders`): criação, consulta (webhook, conciliação e verificação sob demanda), cancelamento (spec-019) e expiração. Nenhuma chamada a `/v1/payments` sobra no código. Teto/backoff da 020 e alertas da 018 continuam funcionando, os testes com MP mockado ficam verdes e `docs/homologacao-local.md` fica pronto para o Pedro rodar no sandbox.

## Contexto

- Achado 5 da homologação (nota "spec-017 Homologação"): o painel do MP avisou que a API de Pagamentos será descontinuada. Esta spec também absorve o achado 2 (500 no 1º POST do Pix em 4 de 4 pedidos) e o achado 1 (MP recusa `test_user_<id>@testuser.com` com 403 cause 4390).
- Decisões do Pedro: nota "Grilling Orders Pix" (fichário "Fluxo OTILC"), ok nas 19 recomendações, com os ajustes da seção "Respostas do Pedro" (Q2, Q6, Q17). A nota também resume a documentação oficial da API de Orders, com as fontes.
- Fatos do código: nota "Recon Orders Pix" (Formiga, main 095eece). Se algum fato contradisser esta spec, pare e avise a Bússola.
- Produção não tem pagamentos gravados (a tabela `payments` ainda não foi ao ar). Só o banco local do Pedro tem ids numéricos antigos.
- `PaymentTransitionService` continua sendo a única porta de transição (`sync`/`syncFrom`). A interface `PixProvider` mantém os 3 métodos (criar, consultar, cancelar); renomear só com justificativa no PR.
- Garantias de estoque e pedidos: README, "Destaques técnicos". Nada pode regredir.

## Como fazer

### 1. Id guardado (Q1)

- `payments.provider_payment_id` passa a guardar o **id da order** (`ORD…`). O id da transação (`PAY…`) não é guardado. Sem migração.
- A validação do id troca `/^\d{1,30}$/` por uma regex literal de order (ex.: `/^ORD[0-9A-Z]{26,40}$/`), aplicada antes de qualquer chamada ao MP e no webhook.

### 2. Ids antigos (Q2, só banco local)

Conciliação e verificação sob demanda **pulam** payment cujo `provider_payment_id` não é de order: sem chamar o MP, sem contar falha, sem `RECONCILIATION_STOPPED`, com um log (id interno do payment, sem dados do cliente). Nenhum código de compatibilidade com `/v1/payments`.

### 3. Criação (Q5, Q6)

`POST /v1/orders` com `X-Idempotency-Key` determinística (a mesma de hoje por tentativa) e corpo:
`type: "online"`, `processing_mode: "automatic"`, `total_amount` e `transactions.payments[0].amount` como string a partir do `priceCents` do banco (ex.: `"50.00"`, sem float), `external_reference` = id do pedido, `description` "Pedido OTILC #<número>", `payer.email`, `payer.first_name` = primeiro nome de `orders.customer_name` (no sandbox o Pedro digita "APRO"), uma transação `payment_method: { id: "pix", type: "bank_transfer" }` com `expiration_time` em duração ISO 8601 com a mesma margem de hoje. **Sem** `notification_url`.

A resposta precisa ter exatamente uma transação Pix com `qr_code`; senão é erro do provedor. QR e copia-e-cola vêm de `transactions.payments[0].payment_method`. `pixChargeSchema` (shared) e a loja não mudam.

### 4. Consulta e mapeamento (Q3, Q4)

- `GET /v1/orders/{id}`. Status no nível da **order**:
  - `created`, `action_required/*`, `processing/*` → `PENDING`
  - `processed/accredited` → `APPROVED`
  - `processed/partially_refunded` → `APPROVED` + `PAYMENT_REVERSED`
  - `refunded` → `REFUNDED` (+ `PAYMENT_REVERSED` se estava `APPROVED`, como hoje)
  - `charged_back/*` → mantém `APPROVED` + `PAYMENT_REVERSED`
  - `canceled/*` e `failed/expired` → `CANCELLED`
  - `failed/failed` → `REJECTED`
  - desconhecido → `null` (só log, nada muda)
- Valor: `total_amount` (string) → centavos com regex literal, sem float; formato inválido = erro de resposta. `AMOUNT_MISMATCH` confere `external_reference`, `total_amount` e `total_paid_amount` quando presente. Moeda: `currency_id` = BRL quando vier; senão `country_code` = BRA.
- `approvedAt` (para `PAID_AFTER_EXPIRY`): a data de aprovação da transação, se a referência do GET trouxer; senão `last_updated_date` da order na primeira vez que vemos `processed`. Registre no PR qual campo usou e a fonte.

### 5. Cancelamento e expiração (Q7, Q9)

- `POST /v1/orders/{id}/cancel`, sem corpo, com `X-Idempotency-Key` determinística (ex.: `otilc-pix-cancel-<uuid do payment>`).
- `canceled` → `syncFrom` como hoje. `order_already_canceled` ou outro 4xx de "não cancelável" (ex.: já `processed`) → `GET` da order e `syncFrom` do estado real (aprovada segue o caminho da 019: `409` no painel, `PAID_AFTER_EXPIRY` na expiração). Rede/5xx → `failed`, igual à 019.
- Resultados `no_charge | cancelled | approved | pix_disabled | failed` e os códigos HTTP do painel não mudam. A expiração local continua mandando; o `expiration_time` do MP é só a rede de segurança.

### 6. Webhook (Q8, Q12)

- Aceita só `type=order`; `type=payment` e outros → `ignored` com `200`. `data.id` validado com a regex de order na query e no corpo.
- Manifest, HMAC, `timingSafeEqual`, tolerância de ±5 min, `data.id` em minúsculas e dedupe por `x-request-id` não mudam. O status do corpo continua ignorado (GET + `sync`).
- A variável da URL de notificação deixa de ser usada: sai do `env.ts`, do `.env.example` e do client. O roteiro e `docs/api/pagamentos.md` mandam configurar a URL no painel do MP (evento "Order (Mercado Pago)", abas teste e produção).

### 7. Achado 2 e 429 (Q10, Q11)

- Sem retry nesta spec. No erro do MP, um log de diagnóstico: método, rota sem id, HTTP status e o código/mensagem de erro do corpo do MP (truncado). Sem token, e-mail, nome ou payload.
- `429` é tratado como as outras falhas (503 `PIX_UNAVAILABLE` na criação, falha contada no backoff da 020 na conciliação).

### 8. Roteiro de homologação (Q13, Q14)

Reescrever `docs/homologacao-local.md`:

- Passo do painel: ativar o evento Order (teste e produção, mesma URL); depois da virada, desligar o evento de Pagamentos.
- c) pedido + Pix: e-mail comum em produção e `test@testuser.com` no sandbox (registrar o 403 cause 4390 do `test_user_<id>@testuser.com`); anotar se o 1º POST deu 500 (achado 2).
- d) nome "APRO" → webhook `order.processed` → `PAID` + estoque.
- e) expiração cancela a order (`POST /cancel`).
- f) túnel derrubado, APRO aprova, conciliação ou sob demanda → `PAID`.
- g) APRO com túnel derrubado e conciliação parada até o pedido local vencer → a expiração tenta cancelar, MP responde já processado → GET → `EXPIRED` + `PAID_AFTER_EXPIRY` (estorno pelo painel, Pedro).
- h) assinatura inválida → `401` com `type=order`. j/k) 019 pelo `POST /cancel`.
- d, f e g passam para a seção de sandbox; o bloco de Pix real em produção (~R$ 1) fica só com o d.
  Quem executa é o Pedro, depois do merge.

### 9. Contrato e docs

- `packages/shared/src/payments.ts`: só os schemas do webhook (`type` order, id de order).
- `docs/api/pagamentos.md` e `docs/api/admin.md`: trocar as referências a `/v1/payments`, formato do id, webhook de order e configuração no painel.

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- `apps/api/src/payments/**`
- `apps/api/src/admin-orders/**`, `apps/api/src/admin-alerts/**`, `apps/api/src/orders/**`: só onde houver id/regex/formato do MP
- `apps/api/src/config/env.ts`, `apps/api/src/config/env.spec.ts`, `apps/api/.env.example`
- `apps/api/test/**`
- `packages/shared/src/payments.ts` (só os schemas do webhook) e o teste dele no shared, se existir
- `docs/api/pagamentos.md`, `docs/api/admin.md`
- `docs/homologacao-local.md`
- `docs/agents/scorecard.md` (linha 018)
- `specs/021-pix-api-de-orders.md` (esta spec)

## Fora do escopo

- `apps/api/src/db/schema.ts`, `apps/api/drizzle/**`: nenhuma migração. Se precisar, pare e reporte.
- `apps/web/**`: a Forja confirma que a web não monta link com `providerPaymentId` numérico; se montar, pare e reporte.
- Retry automático do POST (só se o achado 2 persistir, em spec seguinte), respeitar `Retry-After`, estorno pela API, busca `/v1/orders/search`.
- Compatibilidade com `/v1/payments` para ids antigos.
- `.github/workflows/**`, credenciais, `.env` real, painéis do MP/Render/Supabase. O MP é sempre mockado nos testes.
- **Ambiente local do Pedro**: nada de `db:migrate`/`db:seed` no banco local nem mexer na API rodando. `npm run test:e2e:web` só depois de o Pedro avisar que a homologação da 020 terminou (~15:20 UTC); até lá, unitários e `npm run test:e2e` (banco `otilc_test`).

## Critérios de aceite

- [ ] (unit) `mercadopago.client.spec.ts` reescrito: `POST /v1/orders` (payload da seção 3, headers, idempotência, sem `notification_url`, `first_name` do cliente), `GET /v1/orders/{id}`, `POST /v1/orders/{id}/cancel` com idempotência; id inválido recusado sem chamar a rede; `total_amount` string → centavos; resposta sem transação Pix = erro; log de erro sem token/e-mail/nome.
- [ ] (unit) Tabela completa de mapeamento de status da seção 4.
- [ ] (unit) Teste que falha se aparecer `/v1/payments` em `apps/api/src` (regex literal).
- [ ] (e2e) Webhook `type=order` aceito; `type=payment` ignorado (200); `data.id` numérico recusado.
- [ ] (e2e) Cancelamento com order já `processed` → GET → `409` no painel e `PAID_AFTER_EXPIRY` na expiração; `order_already_canceled` → `CANCELLED`.
- [ ] (e2e) Payment com id antigo numérico pulado pela conciliação e pela sob demanda: sem chamada ao MP, `check_failures` intacto, sem `RECONCILIATION_STOPPED`.
- [ ] Testes existentes de payments, conciliação, alertas, admin-orders (incluindo concorrência), backoff e rls passam; só fixtures de id mudam (numérico → `ORD` fictício), sem enfraquecer asserção.
- [ ] `docs/api/pagamentos.md`, `docs/api/admin.md` e `docs/homologacao-local.md` atualizados (seções 8 e 9).
- [ ] Scorecard (commit `docs(agents)` separado): linha 018 entre 017 e 019, Uso/tokens "~3% da semana (49% → 52%)".
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes; `npm run test:e2e:web` verde (depois do aviso do Pedro).

## Notas para o revisor

- Nenhuma chamada ao MP com transação ou trava aberta (garantia das 015/019).
- Confira o mapeamento de status, em especial `canceled` (um L), `failed/expired` e `charged_back`.
- Valor em string → centavos sem float; preço nunca do navegador.
- O cancelamento "não cancelável" tem de cair no GET + `syncFrom`, senão a 019 regride (pedido pago pelo Pix virando 502).
- Logs sem token, e-mail, nome do cliente ou payload do MP.
- Teto/backoff da 020: ids antigos não podem contar falha nem parar a conciliação.
