# spec-003 — Telas do painel administrativo (web)

- Papel: `frontend`
- Agente sugerido: Codex
- Depende de: spec-001
- Pode rodar em paralelo com: spec-002, spec-004
- Branch: `spec-003-web-painel-admin`

## Objetivo

Telas do painel em `/admin` no Next.js — login, lista e edição de produtos, estoque por variação, lista e detalhe de pedidos — funcionando contra **dados de exemplo tipados** e prontas para usar a API real trocando um único módulo.

## Contexto

A API está sendo feita em paralelo por outro agente. Use os schemas e DTOs de `packages/shared/src/admin.ts` e o contrato em `docs/api/admin.md`. Leia a ADR 0002: o navegador chama `/api/admin/*` **na origem da própria loja**, e o `next.config.ts` reescreve para a API.

Siga o visual atual da loja (`globals.css`, componentes existentes). Mobile first: o dono vai usar o painel no celular.

## Arquivos permitidos

- `apps/web/src/app/admin/**`
- `apps/web/src/components/admin/**`
- `apps/web/src/lib/admin-api.ts` (cliente real) e `apps/web/src/lib/admin-api.mock.ts` (dados de exemplo tipados)
- `apps/web/next.config.ts` (somente a regra de rewrite `/api/admin/:path*` → `${API_URL}/api/admin/:path*`)
- `apps/web/package.json`, `apps/web/vitest.config.ts` e `apps/web/src/**/*.test.tsx` (para adicionar Vitest + Testing Library — a loja ainda não tem testes; justifique no PR)
- `package-lock.json` (apenas pelo `npm install` das dependências acima)
- `apps/web/.env.example` (apenas a linha `NEXT_PUBLIC_ADMIN_MOCK`)

## Fora do escopo

- Alterar `packages/shared`, `docs/api` ou qualquer arquivo de `apps/api`.
- Upload de imagem (use campo de URL), Pix, relatórios.
- Guardar token ou dados de sessão em `localStorage` (a sessão é só o cookie httpOnly).

## Critérios de aceite

- [ ] `NEXT_PUBLIC_ADMIN_MOCK=1` faz o painel usar `admin-api.mock.ts`; sem ela, usa `admin-api.ts` (variável documentada no `.env.example`)
- [ ] `/admin/login` valida o formulário com `adminLoginSchema` e mostra erro genérico em 401
- [ ] Páginas de `/admin` (exceto login) redirecionam para o login quando `GET /api/admin/me` responde 401
- [ ] Lista de produtos com status, preço (`formatBRL`), estoque total e reservado
- [ ] Edição de produto e criação de variação validadas com os schemas do shared; campos de preço escondidos/desabilitados para `STAFF` (via `canRole`)
- [ ] Atualização de estoque mostra a mensagem do 409 ("abaixo do reservado")
- [ ] Pedidos: filtro por status, detalhe, e só os botões de transição permitidos por `canTransitionOrder`
- [ ] `/admin/**` com `robots: noindex`
- [ ] Testes Vitest: redirecionamento sem sessão, esconder preço para STAFF, botões de transição, erro 409 de estoque
- [ ] `npm run format:check && npm run typecheck && npm test && npm run build` verdes

## Notas para o revisor

- Confira que nada fala com a API fora de `lib/admin-api.ts`.
- Confira que o rewrite não abre outras rotas além de `/api/admin`.
