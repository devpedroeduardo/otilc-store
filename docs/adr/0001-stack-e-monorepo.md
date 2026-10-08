# ADR 0001 — Stack e monorepo

- Status: aceito
- Data: 2026-10-08

## Contexto

A loja da OTILC precisa de back-end próprio, front-end com bom SEO para catálogo e um fluxo em que vários agentes de IA trabalhem em paralelo sem pisar uns nos outros.

## Decisão

- Monorepo pnpm: `apps/api` (NestJS + Prisma + PostgreSQL), `apps/web` (Next.js App Router), `packages/contracts` (OpenAPI).
- O contrato OpenAPI é escrito **antes** da implementação e é a fronteira entre agentes de back e front.
- Prisma como ORM (schema declarativo facilita revisão de PR e geração de migrações).
- Preço em centavos inteiros.

## Consequências

- Back e front podem ser desenvolvidos em paralelo: o front usa mocks gerados do contrato até a API existir.
- Mudança de contrato vira tarefa própria, sequencial, aprovada por humano.
- Prisma pode ser trocado por TypeORM/Drizzle no futuro, mas isso exige nova ADR.
