# spec-010 — RLS habilitado em todas as tabelas do Supabase

- Papel: `seguranca` (com `backend` para a migração) — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code, Opus 5.5). Revisora: Faísca (Codex, só leitura, papel `revisor`)
- Depende de: nenhuma
- Pode rodar em paralelo com: qualquer spec que não toque em `apps/api/drizzle/**`
- Branch: `spec-010-rls-supabase`

## Objetivo

Existe a migração `0003` que habilita Row Level Security (RLS), **sem nenhuma policy**, nas 8 tabelas do schema `public`. Com isso a Data API do Supabase (supabase-js, roles `anon` e `authenticated`) não lê nem escreve nada, e a API NestJS continua funcionando igual.

## Contexto

- Produção é Supabase (projeto `fodjxmyekcuqthafzaqw`, us-east-1). As migrações `0000` a `0002` já estão aplicadas lá; as tabelas estão vazias.
- O Security Advisor do Supabase acusa ERROR "RLS Disabled in Public" em: `products`, `variants`, `categories`, `product_images`, `orders`, `order_items`, `admin_users`, `admin_sessions`.
- Arquitetura: a API NestJS é a **única** porta do banco. Ela conecta como **dona** das tabelas, e o dono ignora RLS quando não há `FORCE`. Por isso RLS sem policy = "nega tudo" para `anon`/`authenticated` e não afeta a API.
- O mesmo vale localmente: o usuário `otilc` do docker compose é dono das tabelas, então os e2e existentes devem continuar verdes sem mudança.

## Como fazer

1. Na pasta `apps/api`: `npx drizzle-kit generate --custom --name enable_rls`. Isso cria `drizzle/0003_enable_rls.sql`, `drizzle/meta/0003_snapshot.json` e a entrada `idx: 3` no `_journal.json`. **Não** escreva o journal à mão.
2. Preencha o SQL com um `ALTER TABLE "<tabela>" ENABLE ROW LEVEL SECURITY;` por tabela, as 8 explícitas, separadas por `--> statement-breakpoint` como nas migrações anteriores.
3. Teste de integração novo em `apps/api/test/rls.e2e-spec.ts` (detalhes nos critérios).

## Regras

- **Proibido** `FORCE ROW LEVEL SECURITY`: quebraria a API, que depende de ser dona.
- **Proibido** criar policy, `GRANT`/`REVOKE`, role ou função. Só `ENABLE ROW LEVEL SECURITY`.
- SQL válido em Postgres 16 puro e no Supabase: nada que dependa de schema/role do Supabase (`auth`, `anon`, `authenticated`).
- Não edite as migrações `0000` a `0002` nem seus snapshots.
- Após a mudança, `npm run db:generate -w @otilc/api` não pode gerar migração nova (sem drift entre `schema.ts` e o snapshot).

## Arquivos permitidos

- `apps/api/drizzle/0003_*.sql`
- `apps/api/drizzle/meta/0003_snapshot.json`
- `apps/api/drizzle/meta/_journal.json` (só a entrada nova, gerada pelo drizzle-kit)
- `apps/api/test/rls.e2e-spec.ts` (novo)
- `specs/010-rls-supabase.md` (esta spec, já escrita)

## Fora do escopo

- Aplicar no Supabase. **Nenhum agente roda nada contra o Supabase**; o Pedro aplica depois do merge.
- `apps/api/src/db/schema.ts` (ex.: `.enableRLS()`), código da API, web, `packages/shared`, `docs/api/**`, `.github/`.
- Policies para acesso via supabase-js: não há cliente que use a Data API.
- Revogar grants de `anon`/`authenticated` ou desligar a Data API: decisão separada do Pedro.

## Critérios de aceite

- [ ] Migração `0003` gerada pelo drizzle-kit; `_journal.json` com entradas `idx` 0..3 consistentes e tag igual ao nome do `.sql`
- [ ] O SQL contém exatamente 8 `ENABLE ROW LEVEL SECURITY`, um por tabela listada, e nenhum `FORCE`, `POLICY`, `GRANT` ou `REVOKE`
- [ ] `npm run db:migrate` aplica limpo num banco local novo e é no-op na segunda execução
- [ ] `rls.e2e-spec.ts` consulta `pg_class`/`pg_namespace` (via `sql` do Drizzle) e verifica:
  - [ ] as 8 tabelas existem e têm `relrowsecurity = true`
  - [ ] **toda** tabela do schema `public` (`relkind` `r` ou `p`) tem `relrowsecurity = true`, para que uma tabela futura sem RLS quebre o teste
  - [ ] nenhuma tem `relforcerowsecurity = true`
- [ ] Os e2e existentes passam sem alteração (prova de que o dono continua ignorando RLS)
- [ ] `npm run db:generate -w @otilc/api` depois da mudança não cria arquivo novo
- [ ] `git diff --name-only origin/main` só lista arquivos permitidos
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes; CI verde

## Notas para o revisor

- Confirme que não há `FORCE` nem policy, e que o journal não foi editado à mão (`when` coerente, `breakpoints: true`).
- Confirme que o teste falharia se a migração fosse removida (ele precisa testar o banco migrado, não um mock).
- Avalie o risco no Supabase: o usuário que roda as migrações lá precisa ser dono das tabelas (o Pedro confirma na aplicação).
- O `schema.ts` não declara RLS; registre se isso pode virar drift em versões futuras do drizzle-kit, mas não exija mudança nesta spec.
