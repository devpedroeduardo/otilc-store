# spec-007 — Cookie do admin visível para as páginas do painel

- Papel: `backend`
- Agente sugerido: Claude Code
- Depende de: spec-002
- Pode rodar em paralelo com: correções da spec-003 (PR #9)
- Branch: `spec-007-cookie-path-admin`

## Objetivo

O cookie `otilc_admin` passa a ter `Path=/`, para que as páginas `/admin/**` do Next.js (que checam a sessão no servidor) recebam o cookie. Hoje, com `Path=/api/admin`, o navegador não envia o cookie para `/admin`, e todo login volta para a tela de login (achado B1 da revisão do PR #9).

## Contexto

- Continua `HttpOnly`, `SameSite=Strict`, `Secure` em produção e 8 horas. Só o `Path` muda.
- O navegador fala com a API pela origem da loja (rewrite `/api/admin/:path*`), então o cookie é da origem da loja e, com `Path=/`, vai tanto para `/admin/**` (páginas) quanto para `/api/admin/**` (API via rewrite).
- A API em si não muda de comportamento: ela já lê o cookie pelo nome.

## Arquivos permitidos

- `apps/api/src/admin-auth/session-token.ts` (constante do path)
- `apps/api/src/admin-auth/**/*.spec.ts` e `apps/api/test/admin-auth.e2e-spec.ts` (ajustar asserções do `Set-Cookie`)
- `docs/adr/0002-autenticacao-admin.md` (registrar a mudança em uma seção "Ajustes da spec-007", com o motivo)
- `docs/api/admin.md` (atributos do cookie)

## Fora do escopo

- Qualquer arquivo de `apps/web`.
- Mudar nome, validade, `SameSite` ou `HttpOnly` do cookie.

## Critérios de aceite

- [ ] Login devolve `Set-Cookie` com `Path=/`, `HttpOnly`, `SameSite=Strict` e `Max-Age=28800` (teste de integração)
- [ ] Logout limpa o cookie com o mesmo `Path=/` (teste); um cookie limpo com path diferente não apagaria o original
- [ ] ADR 0002 e `docs/api/admin.md` atualizados, sem sobrar menção a `Path=/api/admin`
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes

## Notas para o revisor

- Confira que nenhum outro atributo do cookie mudou de carona.
