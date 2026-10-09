# spec-008 — Job de expiração sem risco de deadlock + corrida pagar × expirar

- Papel: `backend`
- Agente sugerido: Claude Code (revisão: Codex)
- Depende de: spec-005
- Pode rodar em paralelo com: specs que não toquem `apps/api/src/orders/**` nem `apps/api/src/admin-orders/**`
- Branch: `spec-008-expiracao-sem-deadlock`

## Objetivo

O job de expiração passa a travar as variações na mesma ordem do checkout e do painel, e um teste de integração prova que "marcar pago" e "expirar" ao mesmo tempo nunca produzem os dois efeitos.

## Contexto

Leia `README.md` ("Destaques técnicos"), `OrdersService.create`, `OrdersService.releaseExpired` e `AdminOrdersService.updateStatus`.

Hoje há uma regra de ordem de trava que vale para o checkout e para o painel, mas não para o job:

- **Checkout** (`create`): junta itens repetidos com `mergeCartItems` e trava as variações em ordem de `variantId` (`localeCompare`).
- **Painel** (`updateStatus`): trava o pedido e depois as variações, com o mesmo merge e a mesma ordenação.
- **Job** (`releaseExpired`): trava os pedidos vencidos (`FOR UPDATE SKIP LOCKED`) e depois atualiza as variações **na ordem em que os itens voltam do banco**, sem merge e sem ordenar.

O problema: o job libera o pedido 1 (variação B) e o pedido 2 (variação A), atualizando B e depois A. Ao mesmo tempo, um checkout reserva A e depois B. Cada transação fica esperando a outra e o Postgres aborta uma delas com deadlock (`40P01`). No job, a rodada falha inteira e as reservas vencidas ficam presas até a próxima. No checkout, o cliente recebe erro 500.

Corrida pagar × expirar: o painel só marca como pago com `expires_at > now()` e `WHERE status = 'PENDING_PAYMENT'`. O job usa `FOR UPDATE SKIP LOCKED`. Pelo desenho, só um dos dois deve vencer, mas hoje nenhum teste prova isso. O teste existente "painel e job de expiração ao mesmo tempo" cobre só o **cancelamento**.

## Arquivos permitidos

- `apps/api/src/orders/lock-order.ts` (novo) e `apps/api/src/orders/lock-order.spec.ts` (novo)
- `apps/api/src/orders/orders.service.ts`
- `apps/api/src/admin-orders/admin-orders.service.ts` (só para usar o helper, sem mudar comportamento)
- `apps/api/test/orders.e2e-spec.ts` e `apps/api/test/admin-orders.e2e-spec.ts` (só acrescentar testes)

## O que fazer

1. **Criar `lock-order.ts`** com uma função única que recebe linhas `{ variantId, quantity }`, junta as repetidas (`mergeCartItems` do shared) e devolve em ordem de `variantId` com `localeCompare`. Comentário curto explicando por que todas as transações precisam da mesma ordem.
2. **Usar essa função nos três lugares** (`create`, `updateStatus` e `releaseExpired`). Assim a regra de ordem fica num lugar só. Em `create` e `updateStatus` o comportamento não pode mudar.
3. **Corrigir o `releaseExpired`:** juntar os itens de todos os pedidos vencidos da rodada e atualizar cada variação **uma vez**, na ordem da função. Mantenha o `FOR UPDATE SKIP LOCKED`, a ordem "pedidos antes das variações" e o parâmetro `now`, que os testes usam.

## Fora do escopo

- Trocar o `GREATEST(reserved - q, 0)` do job (ver "Notas para o revisor").
- Limitar quantos pedidos o job processa por rodada.
- Trocar o relógio do job (`new Date()` da aplicação) pelo `now()` do banco.
- Qualquer mudança em `packages/shared`, `schema.ts`, migrações, `docs/api` ou no intervalo do job.

## Critérios de aceite

- [ ] `lock-order.spec.ts`: junta repetidos, ordena por `variantId` e não altera a entrada.
- [ ] `releaseExpired` com dois pedidos vencidos que usam a **mesma** variação: `reserved` cai pela soma, numa única atualização dessa variação.
- [ ] **Teste de estresse checkout × job:** os pedidos vencidos são criados de forma que os itens voltem do banco fora de ordem (ex.: pedido 1 só com a variação de maior id, pedido 2 só com a de menor). Em várias rodadas (≥ 20), `releaseExpired` e um checkout das duas variações rodam ao mesmo tempo. Nenhum erro `40P01` aparece, e no fim `reserved` de cada variação é igual à soma das quantidades dos pedidos `PENDING_PAYMENT` dela.
- [ ] Rode o teste de estresse **antes** da correção e registre no PR se ele falhou (vermelho) ou não reproduziu. Deadlock depende de tempo, então "não reproduziu" é resposta aceitável, desde que registrada.
- [ ] **Teste pagar × expirar:** vários pedidos com prazo ainda válido para o banco. Para cada um, `PATCH status=PAID` e `releaseExpired(now no futuro)` rodam ao mesmo tempo. Cada pedido termina **ou** `PAID` (resposta 200) **ou** `EXPIRED` (o PATCH recebe 409), nunca os dois. Por variação, no fim: `reserved = 0` e `stock = estoque inicial − pedidos PAID`.
- [ ] Os testes existentes continuam iguais e verdes, em especial os de concorrência.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e && npm run test:e2e:web` verdes.

## Notas para o revisor

- Confira que **todo** UPDATE em `variants` dentro de transação com mais de uma variação passa pela função de ordenação.
- Confira que a ordem continua "pedidos antes das variações" no painel e no job. O checkout só trava variações.
- Os testes de concorrência não podem depender de `setTimeout`/sleep para "acertar" a corrida: `Promise.all` sobre várias rodadas.
- Fica para o backlog: o `GREATEST(..., 0)` do job esconde uma reserva inconsistente em silêncio, enquanto o painel falha com 500 e loga. Se o revisor achar que vale, vira spec própria.
