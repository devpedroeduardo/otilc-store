# spec-019 — Cancelar o Pix no Mercado Pago ao marcar pago ou cancelar pelo admin

- Papel: `backend` + `seguranca` (Forja) — ver docs/agents/roles/
- Agente sugerido: Forja (só implementa). Fatos pendentes e vigia do CI: Formiga. Revisão: Lente; segunda revisão: Faísca (pagamento). O Pedro lê o diff inteiro.
- Depende de: spec-015 (cancelamento na expiração) e spec-017 (PUT de cancelamento validado no caso e)
- Pode rodar em paralelo com: nada que toque em `apps/api/src/payments/**` ou `apps/api/src/admin/**`
- Branch: `spec-019-cancelar-pix`

## Objetivo

Quando o admin marca um pedido como pago (`PENDING_PAYMENT → PAID`) ou cancela um pedido pendente (`PENDING_PAYMENT → CANCELED`), o Pix `PENDING` desse pedido é cancelado no Mercado Pago (MP) **antes** de o status mudar no banco. O QR antigo deixa de ser pagável e não há cobrança dupla. Se o cancelamento falhar, nada muda no banco, o admin recebe um erro claro e a falha fica no log.

## Contexto

- Achado 3 da homologação (nota "spec-017 Homologação"): hoje o Marcar pago não chama o MP; o payment fica `PENDING` e o cliente ainda consegue pagar o QR. Se pagar, o webhook ou a conciliação grava `DUPLICATE_PAYMENT`: a cobrança dupla é detectada, não evitada.
- Decisões do Pedro: nota "Grilling Cancelar Pix" (fichário "Fluxo OTILC"), ok nas 12 recomendações.
- Fatos do código: nota "Recon Cancelar Pix", incluindo a seção "8. Complemento" (fatos a, b, c confirmados pela Formiga antes do build). Se algum fato do complemento contradisser esta spec, pare e avise a Bússola.
- Contrato atual: `docs/api/admin.md` e `docs/api/pagamentos.md`. Garantias de estoque e pedidos: README, seção "Destaques técnicos". Nada disso pode regredir.
- `PaymentTransitionService` é a única porta de transição de pagamento (`syncFrom`/`sync`); o cancelamento **reusa** essa porta, não cria outro caminho.

## Como fazer

### 1. Ordem: cancelar no MP antes de gravar (Q1 = B)

Em `AdminOrdersService.updateStatus`, para `PENDING_PAYMENT → PAID` e `PENDING_PAYMENT → CANCELED`:

1. Buscar o payment `PENDING` do pedido (no máximo um, pelo índice único).
2. Se existir: chamar `cancelPayment` no MP **fora de qualquer transação ou trava** e aplicar a resposta com `syncFrom`, como na expiração.
   - MP confirma `cancelled` → payment `CANCELLED` → segue para o passo 3.
   - MP responde que o Pix já estava aprovado (o cliente pagou naquele instante) → o `syncFrom` marca o pedido `PAID` pelo caminho normal (estoque baixa uma vez). O admin recebe `409` com a mensagem "Este pedido já foi pago pelo Pix." e o passo 3 não acontece. Sem alerta `DUPLICATE_PAYMENT`.
   - PUT falha (`PixProviderError`, timeout, 5xx) → `502` com a mensagem "Não foi possível cancelar o Pix no Mercado Pago. Tente de novo." e `logger.warn` com id do pedido e do payment (sem token, sem dados do cliente). Nada muda no banco.
3. Transação atual do Marcar pago/Cancelar, sem mudança: UPDATE condicional (`status = from`, e `expires_at > now()` ao pagar) e efeito de estoque. Zero linhas continua `409`.

Fatos do Recon §8: (a) `APPROVED` para pedido `CANCELED` hoje cai em `PAID_AFTER_EXPIRY`; (b) a conciliação nunca refaz o PUT, só faz GET; (c) sem provider o cancelamento retorna em silêncio. Por isso a ordem B é a garantia: não existe retry depois.

`PAID → CANCELED` e `PAID → SHIPPED` não mudam (não há Pix pendente; estorno é outra spec).

### 2. Sem Pix ou Pix desligado (Q2)

- Pedido sem payment `PENDING`: não chama o MP; o comportamento é exatamente o de hoje.
- Payment `PENDING` no banco com o Pix desligado no ambiente (sem `MP_ACCESS_TOKEN`): recusa com erro claro (`502` ou `503`, siga o padrão de "Pix indisponível" que já existe) e nada muda. Pular reabriria a cobrança dupla.

### 3. Reuso do código (Q7)

- Extrair de `cancelForExpiredOrders` um método de cancelamento de um pedido (ex.: `cancelPendingCharge(orderId)`), usado pela expiração e pelo admin, que devolve o resultado (cancelado / já aprovado / sem Pix / Pix desligado / falhou) para o chamador decidir. Hoje, sem provider, `cancelForExpiredOrders` retorna em silêncio (fato c do Recon §8): a expiração pode continuar assim, mas o admin precisa receber "Pix desligado" para recusar.
- A expiração mantém o comportamento atual: falha só vai para o log e o estoque continua liberado. Os testes de expiração ficam intactos.

### 4. Contrato e docs (Q6)

- `AdminOrderDetailDto` e `adminOrderStatusUpdateSchema` **não** mudam.
- `docs/api/admin.md`: o PATCH de status documenta o cancelamento do Pix e os erros novos (`409` "já pago pelo Pix", `502` falha ao cancelar e o caso do Pix desligado).
- `docs/api/pagamentos.md`: uma linha dizendo que o Pix também é cancelado quando o admin marca pago ou cancela.
- Web: se a tela do admin já mostra a mensagem de erro que vem da API, nenhuma mudança. Se não mostrar, mudança mínima só de exibição da mensagem.

### 5. Roteiro de homologação (Q10)

`docs/homologacao-local.md` ganha os casos **j** (Marcar pago com Pix gerado → payment `CANCELLED` no banco, Pix cancelado no painel do MP, QR recusado ao tentar pagar) e **k** (Cancelar pedido pendente com Pix gerado, idem, reserva devolvida). Texto curto, no estilo dos casos existentes, só sandbox. Quem executa é o Pedro, depois do merge.

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- `apps/api/src/admin-orders/**` (service, controller, módulo e specs do admin de pedidos)
- `apps/api/src/payments/**` (extração do cancelamento, módulo, specs)
- `apps/api/src/orders/order-expiration.service.ts` (só se a extração exigir trocar a chamada)
- `apps/api/test/admin-orders.e2e-spec.ts`, `apps/api/test/payment-reconciliation.e2e-spec.ts`, `apps/api/test/pix-setup.ts`
- `apps/api/test/payments.e2e-spec.ts`: só para acrescentar o spy de `cancelPayment` no `beforeEach`, sem mudar nenhuma asserção (emenda da Bússola, 2026-10-29: o teste de `DUPLICATE_PAYMENT` marca pago pelo painel com Pix `PENDING`)
- `apps/web/src/**`: só o componente do painel que muda o status do pedido, e só para exibir a mensagem de erro da API, se hoje não exibir
- `docs/api/admin.md`, `docs/api/pagamentos.md` (só o descrito na seção 4)
- `docs/homologacao-local.md` (casos j e k)
- `specs/019-cancelar-pix-ao-marcar-pago.md` (esta spec), `docs/agents/scorecard.md` (linha 017 e linha 019)

## Fora do escopo

- `packages/shared/src/**`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/**`: nenhum enum, alerta ou migração nova. Se precisar, pare e reporte.
- Alerta novo `PIX_CANCEL_FAILED` e retry do cancelamento pela conciliação (só valeriam com a opção A, descartada).
- Estorno automático, `PAID → CANCELED` com reembolso, painel de alertas (spec-018), teto/backoff da conciliação, migração para a API de Orders.
- Mudar o comportamento da expiração, da conciliação ou do webhook.
- Credenciais reais do MP e chamadas ao sandbox em teste: o MP é sempre mockado (`test/pix-setup.ts`). Nenhum agente toca `.env` real.

## Critérios de aceite

- [ ] (e2e) Marcar pago com Pix `PENDING`: PUT de cancelamento chamado 1×, payment `CANCELLED`, pedido `PAID`, estoque baixado uma vez.
- [ ] (e2e) PUT falha: `502` com a mensagem da seção 1; pedido `PENDING_PAYMENT`, payment `PENDING`, estoque e reserva intactos; `warn` no log sem dados do cliente.
- [ ] (e2e) PUT responde aprovado: pedido `PAID` pelo Pix, admin recebe `409` "já pago pelo Pix", estoque baixado uma vez, nenhum alerta `DUPLICATE_PAYMENT`.
- [ ] (e2e) Pedido sem Pix: nenhuma chamada ao MP; Marcar pago igual a hoje.
- [ ] (e2e) Pix desligado com payment `PENDING`: erro, nada muda no banco.
- [ ] (e2e) Os três primeiros casos também para `PENDING_PAYMENT → CANCELED` (reserva devolvida no caso de sucesso).
- [ ] (e2e) Webhook `APPROVED` atrasado de payment já `CANCELLED` (pedido `PAID` pelo admin) não muda pedido nem estoque e segue o que o `syncFrom` faz hoje (documente no PR qual alerta, se algum, é gravado).
- [ ] (unit) A chamada ao MP acontece antes da transação e nenhuma transação ou trava fica aberta durante o PUT.
- [ ] Testes existentes de admin-orders (incluindo a concorrência pagar × expirar), payments, conciliação/expiração e rls passam sem enfraquecimento.
- [ ] `docs/api/admin.md`, `docs/api/pagamentos.md` e `docs/homologacao-local.md` (casos j e k) atualizados.
- [ ] Scorecard (commit `docs(agents)` separado): coluna Uso/tokens da linha 017 = "~7% da semana na execução da homologação (34% → 41%); em 24 h: Maestro 44%, Forja 28%, Bússola 19%, Faísca 9%; ~US$ 72 equiv. no time (Maestro)". A linha 016 já tem os 8%. A linha 019 entra no fechamento.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes; `npm run test:e2e:web` verde.

## Notas para o revisor

- Nenhuma chamada ao MP com transação ou trava aberta.
- A garantia "sem cobrança dupla" vem da ordem (cancelar antes de gravar). Confira que nenhum caminho grava `PAID`/`CANCELED` pelo admin com payment ainda `PENDING`.
- Corrida cliente paga × admin marca pago: o UPDATE condicional (`status = from`) é o que transforma em `409`; confira o teste.
- A expiração não pode mudar de comportamento depois da extração.
- Mensagens de erro e log sem token, sem e-mail ou telefone do cliente.
