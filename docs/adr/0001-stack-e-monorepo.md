# ADR 0001 — Stack e monorepo

- Status: aceito
- Data: 2026-10-08 (registrando decisões já tomadas no código)

## Contexto

A loja da OTILC precisa de back-end próprio com estoque confiável (peças seminovas têm uma unidade só), front-end com bom SEO e um fluxo em que vários agentes de IA trabalhem em paralelo sem pisar uns nos outros.

## Decisão

- Monorepo com npm workspaces + Turborepo: `apps/api` (NestJS), `apps/web` (Next.js App Router), `packages/shared`.
- `packages/shared` é o **contrato** entre API e loja: schemas Zod (validação dos dois lados) e DTOs TypeScript.
- Drizzle ORM com migrações SQL versionadas; regras críticas também como `CHECK` no banco.
- Dinheiro em centavos inteiros; preço sempre calculado no servidor.

## Consequências

- Back e front trabalham em paralelo a partir dos tipos de `packages/shared`; o front usa dados de exemplo tipados até a API existir.
- Mudança de contrato (shared, schema do banco, `docs/api/`) é tarefa própria, sequencial e revisada por humano.
- Trocar qualquer peça da stack exige nova ADR.
