# spec-005 — Integração web + api e testes e2e

- Agente sugerido: Claude Code ou Codex (o que se saiu melhor nas specs 002/003)
- Depende de: spec-002, spec-003, spec-004
- Pode rodar em paralelo com: nada
- Branch: `spec-005-e2e`

## Objetivo

Ligar o web na API real e cobrir o fluxo principal com Playwright.

## Arquivos permitidos

- `apps/web/lib/api/**` (apenas para remover dependência obrigatória do mock)
- `e2e/**`, `playwright.config.ts`
- `package.json` da raiz (apenas script `test:e2e`)

## Fora do escopo

- Mudar contrato, schema ou regras de negócio. Encontrou divergência? Reporte no PR.

## Critérios de aceite

- [ ] Com `docker compose up -d db`, migração, seed e `pnpm dev`, o catálogo mostra os dados da seed
- [ ] E2E: listar produtos → filtrar por categoria → filtrar por tamanho → abrir detalhe → ver tamanho esgotado desabilitado
- [ ] E2E: produto inativo e slug inexistente levam à página 404
- [ ] `pnpm test:e2e` verde localmente
- [ ] Lista no PR de qualquer divergência encontrada entre api e web

## Notas para o revisor

- Este PR mostra se o paralelismo funcionou: quanto retrabalho de integração apareceu?
