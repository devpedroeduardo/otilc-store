# spec-036 — E-mail de confirmação quando o pedido vira PAID

- Papel: backend (pagamento, banco, integração externa) — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code); texto dos próximos passos pela Faísca
- Depende de: nenhuma
- Pode rodar em paralelo com: nenhuma
- Branch: `spec-036-email-confirmacao`

## Objetivo

Todo pedido que passa para `PAID` (webhook, conciliação, verificação sob demanda ou "marcar pago" no painel) gera exatamente 1 e-mail de confirmação para `customer_email`, com número do pedido, itens, total e próximos passos. Reprocessar o pagamento não manda outro e-mail, e uma falha do provedor não desfaz nem atrasa o pagamento.

## Contexto

- Decisões do Pedro (2026-11-09) na nota "Grilling E-mail de confirmação" do fichário "Fluxo OTILC": as 15 recomendações aceitas, com os ajustes das perguntas 8, 9 e 10 descritos abaixo. Reconhecimento da Formiga em main 4fd5a7e.
- Webhook (`mercadopago-webhook.service.ts:75`), conciliação (`payment-reconciliation.service.ts:180`) e verificação sob demanda (`pix.service.ts:249`) passam por `PaymentTransitionService.sync` (`payment-transition.service.ts:66`). A mudança para `PAID` é o UPDATE condicional `WHERE status = 'PENDING_PAYMENT'` dentro da transação; `changed.length > 0` (`:103`) indica que este processamento fez a transição. Repetições caem em `duplicate_payment`, `already_approved` ou na notificação repetida barrada pelo `x-request-id`.
- O "marcar pago" do painel não passa por esse serviço: `admin-orders.service.ts:33-45` faz o próprio UPDATE condicional na transação.
- Não existe e-mail, outbox nem fila. Os jobs usam `setInterval` com `skipIfRunning` e `timer.unref()` (`order-expiration.service.ts:29`, `payment-reconciliation.service.ts:84`). O backoff de `reconciliation-backoff.ts` pode ser reaproveitado.
- Dados: `orders` (`schema.ts:130`) tem `number`, `customer_name`, `customer_email`, `total_cents`; `order_items` (`schema.ts:150`) tem `product_name`, `size`, `unit_price_cents`, `quantity`.
- O cliente do Mercado Pago usa `fetch` injetado e os testes trocam por fake (`mercadopago.client.spec.ts:60`, `test/pix-setup.ts:93`). O cliente de e-mail segue o mesmo padrão.
- Env validada com Zod em `apps/api/src/config/env.ts` (`envSchema` em `:9`).

## Regras

### Outbox

Migração `0008` cria `email_outbox`: `order_id` (FK para `orders`), `kind` (só `'order_confirmation'` por enquanto, com `CHECK`), `status` (`pending` | `sent` | `failed`, com `CHECK`), `attempts`, `next_attempt_at`, `last_error`, `provider_message_id`, `sent_at` e `created_at` com timezone, e `UNIQUE (order_id, kind)`. A tabela nova segue o mesmo padrão de RLS das existentes. Sem backfill: pedidos que já estão `PAID` não recebem e-mail.

A linha `pending` entra na mesma transação que muda o pedido para `PAID`, só quando este processamento fez a transição: em `payment-transition.service.ts` quando `changed.length > 0`, e em `admin-orders.service.ts` no `PENDING_PAYMENT → PAID`. O insert usa `ON CONFLICT DO NOTHING`. Se a transação desfizer, a linha some junto.

### Envio

O envio acontece fora da transação, num worker no padrão dos jobs existentes (`setInterval` + `skipIfRunning` + `unref`, desligado em `NODE_ENV=test` como o expirador, com um método que os testes chamam direto). Depois do commit, a API dá um gatilho não bloqueante no worker para o e-mail sair em segundos; o webhook e o painel respondem sem esperar o provedor.

O worker pega as linhas `pending` com `next_attempt_at <= now()` usando `FOR UPDATE SKIP LOCKED`, para duas instâncias não mandarem a mesma. Cada envio leva o header `Idempotency-Key: order-confirmation/<orderId>`.

- Sucesso: `sent`, `sent_at` e `provider_message_id`.
- Erro temporário (rede, timeout, 429, 5xx): volta para `pending` com `attempts + 1` e `next_attempt_at` pelo backoff. Na 5ª tentativa sem sucesso, vira `failed`.
- Erro permanente (4xx que não seja 429): `failed` na hora, sem nova tentativa.

Nada disso muda o pedido nem o pagamento. Os logs trazem só `orderId`, `kind`, `status`, número da tentativa e `provider_message_id`; e-mail, nome e telefone do cliente nunca vão para log.

### Provedor

Resend pela API HTTP, com `fetch` injetado e sem SDK, então nenhuma dependência nova. Com `EMAIL_PROVIDER=log`, o cliente não chama rede: registra no log só `orderId` e assunto e devolve sucesso, para a outbox andar igual em dev e teste.

### Variáveis de ambiente

Todas no `envSchema` e no `apps/api/.env.example`, com valores fictícios:

- `EMAIL_PROVIDER`: `resend` | `log`, padrão `log`.
- `RESEND_API_KEY`: obrigatória quando `EMAIL_PROVIDER=resend`; no exemplo, `re_teste_placeholder`.
- `EMAIL_FROM`: no exemplo, `OTILC <pedidos@example.com>`.
- `EMAIL_REPLY_TO`: opcional. Quando existe, vira o reply-to e o contato do rodapé; quando falta, o e-mail sai sem reply-to e sem a linha de contato. O endereço real o Pedro define depois no Render.
- `EMAIL_OUTBOX_INTERVAL_MS`: padrão 30000.

O link para a loja usa o `WEB_ORIGIN` que já existe. No `render.yaml`, `EMAIL_PROVIDER=log` fica fixo e as demais entram como variáveis que o Pedro preenche (`sync: false`), no padrão das `MP_*`.

### Conteúdo

Função TS pura que recebe pedido e itens e devolve `{ subject, html, text }`, em pt-BR, com valores por `formatBRL` do shared. Assunto: "Pedido nº {number} confirmado". Corpo: saudação com `customer_name`, tabela de itens (produto, tamanho, quantidade, preço unitário), total, próximos passos, link para a loja e, se houver `EMAIL_REPLY_TO`, o contato. HTML simples com estilo inline e versão texto. Sem imagem remota e sem pixel de rastreio. Todo dado do pedido é escapado no HTML.

A Faísca escreve um rascunho genérico dos próximos passos, sem prometer prazo, e manda à Forja; o Pedro aprova o texto no PR.

### Produção

A API sobe em produção com `EMAIL_PROVIDER=log` até o Pedro verificar um domínio no Resend (a OTILC ainda não tem domínio próprio). O `docs/deploy.md` ganha uma seção com os passos do Pedro para ligar o envio: verificar o domínio no Resend (SPF, DKIM e DMARC no DNS), criar a chave, preencher `RESEND_API_KEY`, `EMAIL_FROM` e `EMAIL_REPLY_TO` no Render e trocar `EMAIL_PROVIDER` para `resend`. Enquanto estiver em `log`, os pedidos pagos acumulam linhas `sent` sem e-mail real, e a seção avisa que esses clientes não recebem confirmação retroativa.

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- `apps/api/src/email/**` (módulo novo: cliente do provedor, template, worker, testes unitários)
- `apps/api/src/payments/payment-transition.service.ts` e o `.spec.ts` dele
- `apps/api/src/admin-orders/admin-orders.service.ts` e `admin-orders.service.spec.ts`
- `apps/api/src/app.module.ts` (registrar o módulo)
- `apps/api/src/config/env.ts` e o `.spec.ts` dele
- `apps/api/src/db/schema.ts` e `apps/api/drizzle/**` (só a tabela `email_outbox` e a migração `0008` gerada; mudança de contrato autorizada por esta spec)
- `apps/api/test/email-confirmation.e2e-spec.ts` (novo) e `apps/api/test/setup.ts` / `apps/api/test/pix-setup.ts`, se precisar do fake do provedor
- `apps/api/test/rls.e2e-spec.ts` (só para cobrir a tabela nova)
- `apps/api/.env.example`
- `render.yaml` (só as variáveis de e-mail)
- `docs/deploy.md` (seção de e-mail)
- `README.md` (Roadmap: e-mail de confirmação)
- `docs/agents/scorecard.md` (linha 035, commit separado; dados na nota "spec-035 marcar pago estornado")
- `specs/036-email-confirmacao.md`

## Fora do escopo

- Alerta no painel para e-mail `failed` e reenvio manual pelo admin.
- E-mails de outros status (`SHIPPED`, cancelado, estorno, charged_back).
- Webhook do Resend para bounce e reclamação; preferências de comunicação.
- Envio retroativo para pedidos que já estavam `PAID`.
- `packages/shared` (fora usar o `formatBRL` que já existe), `docs/api/**` (nenhum endpoint muda), web.
- Dependência nova (SDK do Resend, nodemailer, react-email).

## Critérios de aceite

Todos os testes rodam sem rede, com o `fetch` do provedor trocado por fake.

- [ ] e2e: webhook aprovado deixa o pedido `PAID`, cria 1 linha na outbox, e o worker chama o provedor 1 vez com destinatário, assunto e `Idempotency-Key` certos; a linha fica `sent`.
- [ ] e2e: o mesmo webhook reprocessado e uma conciliação depois não criam linha nova e não chamam o provedor de novo.
- [ ] e2e: "marcar pago" no painel cria 1 linha e gera 1 envio; uma segunda tentativa não muda nada.
- [ ] e2e: webhook e conciliação simultâneos do mesmo pagamento resultam em 1 linha e 1 envio.
- [ ] e2e: dois ciclos do worker em paralelo sobre a mesma linha `pending` chamam o provedor 1 vez.
- [ ] e2e: provedor responde 500, o webhook responde como hoje, o pedido segue `PAID`, a linha volta para `pending` com `attempts = 1` e `next_attempt_at` no futuro, e o envio sai num ciclo seguinte. Na 5ª falha a linha vira `failed`.
- [ ] e2e: provedor responde 422 e a linha vira `failed` sem nova tentativa; o pedido segue `PAID`.
- [ ] e2e: transição que não chega a `PAID` (rejeitado, expirado) não cria linha.
- [ ] Unitário do template: número, cada item, total via `formatBRL`, link da loja, contato só com `EMAIL_REPLY_TO`, e nome com `<script>` sai escapado.
- [ ] Unitário da env: `EMAIL_PROVIDER=resend` sem `RESEND_API_KEY` falha ao carregar; sem nenhuma variável de e-mail, carrega com `log`.
- [ ] Unitário: nenhum log do módulo contém o e-mail do cliente.
- [ ] Migração `0008` gerada por `npm run db:generate -w @otilc/api`, com `UNIQUE` e `CHECK`; RLS da tabela nova coberta no `rls.e2e-spec.ts`.
- [ ] Testes de concorrência e de estoque existentes intactos.
- [ ] `docs/deploy.md` com os passos do Pedro para sair de `log`; `render.yaml` e `.env.example` só com placeholders.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes, e CI verde no PR.

## Notas para o revisor

- Confira que o insert na outbox está dentro da mesma transação da mudança para `PAID` nos dois caminhos e que só acontece quando este processamento fez a transição.
- Confira que nenhuma falha do provedor chega à transação do pagamento nem à resposta do webhook.
- Confira o `SKIP LOCKED` e o tratamento de 429 como erro temporário.
- Procure PII em log e HTML sem escape.
- Pagamento e banco: 2ª revisão da Faísca e leitura do diff inteiro pelo Pedro.
