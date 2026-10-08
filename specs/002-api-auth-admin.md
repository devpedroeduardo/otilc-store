# spec-002 — Login de administrador na API

- Agente sugerido: Claude Code
- Depende de: spec-001
- Pode rodar em paralelo com: spec-003, spec-004
- Branch: `spec-002-api-auth-admin`

## Objetivo

Login, logout e sessão de administrador na API, com guard reutilizável por papel, exatamente como em `docs/adr/0002-autenticacao-admin.md` e `docs/api/admin.md`.

## Contexto

Contrato, tabelas e schemas já existem (spec-001). Não os altere. Siga os padrões de `src/orders/` (módulo, service, controller, testes e2e com `test/setup.ts`).

## Arquivos permitidos

- `apps/api/src/admin-auth/**` (módulo, service, controller, guard, decorator de papel, unitários `*.spec.ts`)
- `apps/api/src/app.module.ts` (registrar o módulo)
- `apps/api/src/config/env.ts` e `env.spec.ts` (só se precisar de variável nova, ex.: `ADMIN_SESSION_HOURS`)
- `apps/api/.env.example` (mesma variável, valor fictício)
- `apps/api/src/scripts/create-admin.ts` e o script `admin:create` em `apps/api/package.json`
- `apps/api/test/admin-auth.e2e-spec.ts`, `apps/api/test/setup.ts` (só para limpar as tabelas admin entre testes)

## Fora do escopo

- Endpoints de produtos e pedidos do admin (spec-005).
- Qualquer tela. Mudar CORS da API.

## Critérios de aceite

- [ ] `POST /api/admin/session` cria sessão e devolve cookie com os atributos da ADR; credencial errada e usuário inativo devolvem o **mesmo** 401 genérico
- [ ] Token de 32 bytes de `crypto.randomBytes`; banco guarda só o SHA-256
- [ ] Senha com `scrypt` + sal por usuário; verificação com `timingSafeEqual`
- [ ] `DELETE /api/admin/session` apaga a sessão no banco e limpa o cookie
- [ ] `GET /api/admin/me` devolve `AdminUserDto`; 401 sem sessão, com sessão expirada ou revogada
- [ ] Guard exportado para a spec-005 usar, com decorator de papel (`@Roles('OWNER')`) baseado em `canRole`
- [ ] Mutações em `/api/admin` com `Origin` diferente de `WEB_ORIGIN` recebem 403 (teste cobrindo)
- [ ] Login limitado a 5 tentativas por minuto por IP (teste cobrindo o 429)
- [ ] Sessões expiradas são apagadas periodicamente (pode seguir o padrão de `order-expiration.service.ts`)
- [ ] `npm run admin:create -w @otilc/api` pede e-mail, nome, papel e senha pelo terminal (senha sem eco; nunca por argumento) e recusa senha com menos de 12 caracteres
- [ ] Nenhum log contém senha, token ou hash
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes

## Notas para o revisor

- Teste manual: crie um admin com o script, faça login com `curl -i` e confira os atributos do `Set-Cookie`.
- Procure no diff por `console.log` e por qualquer comparação de senha com `===`.
