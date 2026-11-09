# spec-035 — Painel recusa marcar pago pedido com cobrança estornada

- Papel: backend (pagamento) — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code)
- Depende de: spec-032 (cobrança REFUNDED e alerta `PAYMENT_REVERSED` no charged_back)
- Pode rodar em paralelo com: nenhuma
- Branch: `spec-035-marcar-pago-estornado`

## Objetivo

O `PATCH /api/admin/orders/:id/status` com `PAID` responde `409` e não muda nada quando alguma cobrança do pedido foi estornada ou contestada no Mercado Pago. Marcar pago um pedido sem cobrança estornada continua igual a hoje.

## Contexto

- Decisões do Pedro (2026-11-09) na nota "Grilling marcar pago estornado" do fichário "Fluxo OTILC": as 8 recomendações aceitas como estão. A Formiga estava sem cota, então a Bússola fez o reconhecimento pelo grafo e por leitura pontual em origin/main 0097504.
- A candidata saiu da ressalva da Lente na spec-032 (nota "spec-032 Sobra 029").
- A única transição para `PAID` que o painel faz é `PENDING_PAYMENT → PAID` (`packages/shared/src/admin.ts:161-167`).
- `AdminOrdersService.updateStatus` (`apps/api/src/admin-orders/admin-orders.service.ts:98-148`) cancela o Pix pendente fora da transação (`cancelPendingCharge`, que só olha cobrança `PENDING`). Dentro da transação faz o UPDATE condicional, que trava o pedido, e depois confere `hasPendingPix`.
- Hoje dois caminhos deixam o pedido `PAID` com a cobrança estornada:
  1. A cobrança já está `REFUNDED` no banco. `cancelPendingCharge` devolve `no_charge` e o pedido vira `PAID`.
  2. A cobrança está `PENDING` no banco e o Mercado Pago já estornou. O cancelamento aplica `syncFrom`, a cobrança vira `REFUNDED` com alerta `PAYMENT_REVERSED`, o resultado é `cancelled` e o pedido vira `PAID`. O teste `apps/api/test/payment-reconciliation.e2e-spec.ts:1414` garante esse comportamento hoje.
- O charged_back não muda `payments.status`, que fica `PENDING` ou `APPROVED`. Ele só grava `PAYMENT_REVERSED` em `payment_alerts` (`apps/api/src/db/schema.ts:270-284`).
- A web já mostra o `message` da resposta de erro (`apps/web/src/lib/admin-api.ts:32-39`).

## Regra

Cobrança estornada é qualquer linha de `payments` do pedido com `status = 'REFUNDED'`, ou com `PAYMENT_REVERSED` em `payment_alerts`, resolvido ou não. Resolver o alerta não devolve o dinheiro.

A checagem roda dentro da transação, depois do UPDATE condicional que trava o pedido, no mesmo ponto do `hasPendingPix`. Se achar cobrança estornada, lança `ConflictException` e a transação desfaz tudo: o pedido segue `PENDING_PAYMENT` e o estoque não mexe. O alerta que o `syncFrom` gravou no caminho 2 fica, porque foi gravado fora da transação.

A mensagem nova entra em `pixCancelMessages`, com este sentido: "A cobrança Pix deste pedido foi estornada ou contestada no Mercado Pago; ele não pode ser marcado como pago." A Forja pode ajustar a redação sem mudar o sentido.

O teste da linha 1414 muda de expectativa: de "pedido `PAID`" para "`409`, pedido `PENDING_PAYMENT`, cobrança `REFUNDED` com alerta, estoque intacto". É mudança de comportamento pedida pelo Pedro, e o PR explica isso.

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- `apps/api/src/admin-orders/admin-orders.service.ts`
- `apps/api/src/admin-orders/admin-orders.service.spec.ts`
- `apps/api/test/payment-reconciliation.e2e-spec.ts` (ou o e2e de admin-orders, se a Forja achar melhor para os casos novos)
- `docs/api/admin.md` (só uma linha nova na tabela de recusas do `PATCH /api/admin/orders/:id/status`; mudança de contrato autorizada por esta spec)
- `docs/agents/scorecard.md` (linha 034, commit separado)
- `specs/035-marcar-pago-estornado.md`

## Fora do escopo

- Recusar ou avisar em `PAID → SHIPPED` com cobrança estornada (fica como candidata).
- Bloquear o cancelamento do pedido. Cancelar continua livre.
- Migração, `packages/shared`, web, códigos de erro novos.

## Critérios de aceite

- [ ] e2e (a): cobrança já `REFUNDED` no banco, painel marca pago → `409` com a mensagem nova.
- [ ] e2e (b): cobrança `PENDING` e o Mercado Pago responde refunded no cancelamento (caso da linha 1414) → `409`; a cobrança fica `REFUNDED` com `PAYMENT_REVERSED`.
- [ ] e2e (c): charged_back em cobrança `PENDING` com `PAYMENT_REVERSED` → `409`.
- [ ] e2e (d): com o alerta `PAYMENT_REVERSED` resolvido, o painel continua recusando.
- [ ] Em (a) a (d), o pedido segue `PENDING_PAYMENT`, com estoque e reserva iguais aos de antes.
- [ ] Caminho feliz intacto: marcar pago sem cobrança e com Pix pendente cancelado leva a `PAID` como hoje, com os testes existentes verdes.
- [ ] Unitário novo em `admin-orders.service.spec.ts` para a recusa.
- [ ] `docs/api/admin.md` com a linha nova na tabela de recusas.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes, e CI verde no PR.

## Notas para o revisor

- Confira que a checagem fica dentro da transação, depois do UPDATE que trava o pedido, e que pega o caminho 2 (estorno visto durante o cancelamento do Pix).
- Confira que a mudança no teste da linha 1414 troca a expectativa pela recusa, sem enfraquecer o resto do teste (alerta, cobrança `REFUNDED`, estoque).
- Pagamento: 2ª revisão da Faísca e leitura do diff inteiro pelo Pedro.
