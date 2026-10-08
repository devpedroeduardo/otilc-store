# spec-001 — Contrato do painel administrativo

- Agente sugerido: Claude Code (você revisa com muita atenção)
- Depende de: nenhuma
- Pode rodar em paralelo com: **nada** — é a fronteira que libera o paralelismo das specs 002, 003 e 005
- Branch: `spec-001-contrato-admin`

## Objetivo

Definir, sem implementar, tudo que API e loja precisam combinar para o painel administrativo: schemas Zod e DTOs em `packages/shared`, tabelas novas no banco com migração, e a documentação dos endpoints.

## Contexto

Leia `AGENTS.md`, `docs/adr/0002-autenticacao-admin.md`, `apps/api/src/db/schema.ts` e `packages/shared/src/` (veja como `catalog.ts` e `checkout.ts` estão escritos e siga o mesmo estilo).

### Banco (em `apps/api/src/db/schema.ts`)

- enum `admin_role`: `OWNER`, `STAFF`
- `admin_users`: id (uuid), email (único, minúsculo), name, password_hash (text), role, active (bool, padrão true), created_at
- `admin_sessions`: id (uuid), token_hash (varchar 64, único), user_id (fk → admin_users, cascade), expires_at, created_at; índice em `expires_at`
- `CHECK` garantindo e-mail em minúsculas

### Shared (novo `packages/shared/src/admin.ts`, exportado no `index.ts`)

- `adminLoginSchema`: email, password (12 a 200 caracteres)
- `adminRoleSchema`, `AdminUserDto` (id, email, name, role — **nunca** hash)
- `adminProductInputSchema`: slug, name, brand?, description?, note?, priceCents (inteiro > 0), condition (reaproveite `conditionSchema`), status, featured, categorySlug; `adminProductPatchSchema` = parcial do anterior
- `adminVariantInputSchema`: sku, size, color?, stock (inteiro ≥ 0)
- `adminStockUpdateSchema`: stock (inteiro ≥ 0)
- `adminOrderQuerySchema` (status?, pagina, porPagina) e `adminOrderStatusUpdateSchema`
- função pura `canTransitionOrder(from, to)` com as transições permitidas:
  `PENDING_PAYMENT → PAID | CANCELED`, `PAID → SHIPPED | CANCELED`; demais proibidas
- função pura `canRole(role, action)` com as permissões da ADR 0002
- DTOs: `AdminProductDto` (inclui variants com stock e reserved), `AdminOrderListItemDto`, `AdminOrderDetailDto`

### Documentação (novo `docs/api/admin.md`)

Tabela com método, rota, papel mínimo, corpo, respostas e erros de cada endpoint:

- `POST /api/admin/session` (login) · `DELETE /api/admin/session` (logout) · `GET /api/admin/me`
- `GET /api/admin/products` · `GET /api/admin/products/:id` · `POST /api/admin/products` · `PATCH /api/admin/products/:id`
- `POST /api/admin/products/:id/variants` · `PUT /api/admin/variants/:id/stock` (409 se ficar abaixo de `reserved`)
- `GET /api/admin/orders` · `GET /api/admin/orders/:id` · `PATCH /api/admin/orders/:id/status` (409 em transição inválida)

Inclua exemplos de corpo e resposta em JSON e as regras de cookie e CSRF da ADR.

## Arquivos permitidos

- `packages/shared/src/admin.ts`, `packages/shared/src/admin.test.ts`, `packages/shared/src/index.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/drizzle/**` (somente a migração gerada por `npm run db:generate -w @otilc/api`)
- `docs/api/admin.md`
- `docs/adr/0002-autenticacao-admin.md` (só para mudar o status para "aceito" ou registrar ajustes discutidos)

## Fora do escopo

- Controllers, services, guards, telas, script de criação de admin.
- Upload de imagem, Pix, e-mail.

## Critérios de aceite

- [ ] Migração gerada aplica em banco limpo (`npm run db:migrate`) e os testes existentes continuam verdes
- [ ] Testes `node:test` para `canTransitionOrder`, `canRole` e casos de borda dos schemas (preço 0, estoque negativo, e-mail com maiúsculas, senha curta)
- [ ] Nenhum DTO expõe `password_hash` ou `token_hash`
- [ ] `docs/api/admin.md` cobre todos os endpoints listados, com papel mínimo e erros
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes

## Notas para o revisor

- É a decisão mais cara de mudar depois. Leia `admin.ts`, a migração SQL e o `admin.md` inteiros.
- Confira se as permissões batem com o que você quer para a loja (quem pode mudar preço?).
