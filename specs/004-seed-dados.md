# spec-004 — Seed de dados de desenvolvimento

- Agente sugerido: terceiro agente (OpenCode, Copilot CLI ou Cursor) — bom para comparar
- Depende de: spec-001
- Pode rodar em paralelo com: spec-002, spec-003
- Branch: `spec-004-seed`

## Objetivo

Script de seed idempotente que popula o banco local com um catálogo realista de streetwear para desenvolvimento e testes e2e.

## Contexto

Use o schema aprovado na spec-001. As fotos reais ainda não chegaram: use URLs de placeholder (ex.: `https://placehold.co/800x1000?text=OTILC`).

## Arquivos permitidos

- `apps/api/prisma/seed.ts`
- `apps/api/prisma/seed-data/**`
- `apps/api/package.json` (apenas o campo `prisma.seed` e o script `db:seed`)
- `apps/api/test/seed/**`

## Fora do escopo

- Alterar `schema.prisma` ou migrações.
- Qualquer código em `src/`.

## Critérios de aceite

- [ ] 4 categorias (ex.: camisetas, moletons, calças, acessórios) e ~20 produtos
- [ ] Cada produto com 2–6 variantes e 1–3 imagens; pelo menos 2 variantes com estoque 0 e 2 produtos inativos (para testar filtros)
- [ ] Rodar `pnpm --filter api db:seed` duas vezes não duplica dados (upsert por slug/sku)
- [ ] Seed recusa rodar se `DATABASE_URL` não apontar para `localhost` ou `127.0.0.1`
- [ ] Teste que roda a seed em banco limpo e confere contagens
- [ ] `pnpm lint && pnpm typecheck && pnpm test` verdes

## Notas para o revisor

- A trava de `DATABASE_URL` é o ponto mais importante: seed nunca pode rodar em produção.
