# spec-002 — API do catálogo

- Agente sugerido: Claude Code
- Depende de: spec-001
- Pode rodar em paralelo com: spec-003, spec-004
- Branch: `spec-002-api-catalogo`

## Objetivo

Implementar no NestJS os três endpoints de leitura definidos em `packages/contracts/openapi.yaml`.

## Contexto

O contrato e o schema já foram aprovados. Não altere nenhum dos dois. Os dados de teste virão de fixtures criadas no próprio teste (a seed da spec-004 é outro agente).

## Arquivos permitidos

- `apps/api/src/catalog/**`
- `apps/api/src/app.module.ts` (apenas para registrar o módulo)
- `apps/api/test/catalog/**`

## Fora do escopo

- Alterar `openapi.yaml` ou `schema.prisma`.
- Endpoints de escrita, autenticação, cache.

## Critérios de aceite

- [ ] `GET /products` com filtros `category` (slug) e `size`, paginação conforme o contrato
- [ ] Produtos inativos nunca aparecem, nem na lista nem no detalhe
- [ ] `GET /products/{slug}` retorna 404 no formato `{ statusCode, message, error }`
- [ ] Query params inválidos (`pageSize=500`, `size=XXL`, `page=0`) retornam 400
- [ ] Testes unitários do service + testes de integração dos controllers contra o Postgres do docker compose
- [ ] Respostas validadas contra os tipos de `packages/contracts`
- [ ] `pnpm lint && pnpm typecheck && pnpm test` verdes

## Notas para o revisor

- Conferir que não há N+1 (variantes e imagens carregadas com `include`).
- Conferir que nenhum campo interno vaza na resposta.
