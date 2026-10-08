# spec-005 — Endpoints de produtos, estoque e pedidos do admin

- Agente sugerido: o que se saiu melhor na rodada 002/003/004
- Depende de: spec-002 (usa o guard e o decorator de papel)
- Pode rodar em paralelo com: nada (a 006 precisa dela)
- Branch: `spec-005-api-admin-produtos-pedidos`

## Objetivo

Implementar os endpoints de produtos, variações, estoque e pedidos de `docs/api/admin.md`, protegidos pelo guard da spec-002.

## Arquivos permitidos

- `apps/api/src/admin-catalog/**`, `apps/api/src/admin-orders/**`
- `apps/api/src/app.module.ts` (registrar módulos)
- `apps/api/test/admin-catalog.e2e-spec.ts`, `apps/api/test/admin-orders.e2e-spec.ts`

## Fora do escopo

- Alterar contrato, schema do banco, módulo de auth ou o fluxo público de pedidos (`src/orders/`).
- Upload de imagem, Pix.

## Critérios de aceite

- [ ] Todos os endpoints de produtos, variações, estoque e pedidos de `docs/api/admin.md`, com papel mínimo respeitado (teste de 403 para STAFF em criação de produto e mudança de preço)
- [ ] Atualizar estoque para valor abaixo de `reserved` → 409, garantido em transação (não só checagem antes do update)
- [ ] Teste de concorrência: atualização de estoque e criação de pedido simultâneas para a mesma variação nunca deixam `reserved > stock`
- [ ] Mudança de status respeita `canTransitionOrder`; `CANCELED` a partir de `PENDING_PAYMENT` ou `PAID` devolve as unidades reservadas/vendidas ao estoque na mesma transação
- [ ] Slug e SKU duplicados → 409 com mensagem clara
- [ ] Mudança de preço não altera pedidos antigos (teste)
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes

## Notas para o revisor

- Leia com atenção a parte de cancelamento: é onde dinheiro e estoque se encontram.
