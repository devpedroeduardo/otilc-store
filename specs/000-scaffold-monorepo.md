# spec-000 — Scaffold do monorepo

- Agente sugerido: Claude Code
- Depende de: nenhuma
- Pode rodar em paralelo com: **nada** (fundação; roda sozinha)
- Branch: `spec-000-scaffold`

## Objetivo

Repositório `otilc-store` com o monorepo funcionando: api e web sobem, lint/typecheck/test rodam (mesmo com testes mínimos) e o Postgres local sobe via docker compose.

## Contexto

Leia `AGENTS.md` e `docs/adr/0001-stack-e-monorepo.md`. A estrutura criada aqui será usada por todos os outros agentes, então siga exatamente os nomes de pastas e scripts do AGENTS.md.

## Arquivos permitidos

- `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `.gitignore`, `.editorconfig`
- `tsconfig.base.json`, configuração de ESLint e Prettier na raiz
- `docker-compose.yml`, `.env.example`
- `apps/api/**` (projeto NestJS vazio + Prisma inicializado, sem models de negócio)
- `apps/web/**` (projeto Next.js vazio, página inicial com o texto "OTILC — Veja Além")
- `packages/contracts/**` (apenas `package.json` e um `openapi.yaml` com `info` e `paths: {}`)

## Fora do escopo

- Qualquer model de negócio, endpoint ou tela de produto.
- Autenticação, checkout, pagamento.
- Alterar `AGENTS.md`, `CLAUDE.md`, `specs/` ou `.github/`.

## Critérios de aceite

- [ ] `package.json` da raiz com campo `packageManager` (ex.: `pnpm@9.x.y`) e `pnpm-lock.yaml` commitado — o CI depende dos dois
- [ ] Scripts na raiz: `dev`, `lint`, `typecheck`, `test`, `build` (usando `pnpm -r --if-present`)
- [ ] `docker compose up -d db` sobe PostgreSQL 16 com usuário/senha fictícios vindos de `.env.example`
- [ ] `GET /health` na api retorna `{ "status": "ok" }`, com teste Jest
- [ ] Página inicial do web renderiza "OTILC — Veja Além", com teste Vitest
- [ ] TypeScript `strict` em todos os pacotes
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` verdes

## Notas para o revisor

- Conferir que nenhum segredo real foi commitado e que `.env` está no `.gitignore`.
- Conferir versões fixadas (sem `latest`) no `package.json`.
