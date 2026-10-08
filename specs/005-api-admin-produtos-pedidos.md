# spec-005 — Endpoints de produtos, estoque e pedidos do admin

- Papel: `backend`
- Agente sugerido: o que se saiu melhor na rodada 002/003/004
- Depende de: spec-002 (usa o guard e o decorator de papel)
- Pode rodar em paralelo com: nada (a 006 precisa dela)
- Branch: `spec-005-api-admin-produtos-pedidos`

## Objetivo

Implementar os endpoints de produtos, variações, estoque e pedidos de `docs/api/admin.md`, protegidos pelo guard da spec-002.

## Arquivos permitidos

- `apps/api/src/admin-catalog/**`, `apps/api/src/admin-orders/**`
- `apps/api/src/db/schema.ts` e `apps/api/drizzle/**` **somente** para o índice de variação descrito nos critérios (migração gerada por `db:generate`)
- `apps/api/src/app.module.ts` (registrar módulos)
- `apps/api/test/admin-catalog.e2e-spec.ts`, `apps/api/test/admin-orders.e2e-spec.ts`

## Fora do escopo

- Alterar contrato, schema do banco (exceto o índice de variação acima), módulo de auth ou o fluxo público de pedidos (`src/orders/`).
- Upload de imagem, Pix.

## Critérios de aceite

- [ ] Todos os endpoints de produtos, variações, estoque e pedidos de `docs/api/admin.md`, com papel mínimo respeitado (teste de 403 para STAFF em criação de produto e mudança de preço)
- [ ] Atualizar estoque para valor abaixo de `reserved` → 409, garantido em transação (não só checagem antes do update)
- [ ] Teste de concorrência: atualização de estoque e criação de pedido simultâneas para a mesma variação nunca deixam `reserved > stock`
- [ ] Mudança de status respeita `canTransitionOrder`; `CANCELED` a partir de `PENDING_PAYMENT` ou `PAID` devolve as unidades reservadas/vendidas ao estoque na mesma transação
- [ ] Slug e SKU duplicados → 409 com mensagem clara
- [ ] Variação duplicada (mesmo produto, tamanho e cor) → 409, **inclusive quando a cor é nula**. Hoje o índice `variants_product_size_color_idx` trata `NULL`s como diferentes; troque por `.nullsNotDistinct()` (Postgres 15+) e cubra com teste de integração
- [ ] Mudança de preço não altera pedidos antigos (teste)
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes

## Notas para o revisor

- Leia com atenção a parte de cancelamento: é onde dinheiro e estoque se encontram.
