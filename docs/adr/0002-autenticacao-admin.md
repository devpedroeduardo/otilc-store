# ADR 0002 — Autenticação do painel administrativo

- Status: aceito (spec-001)
- Data: 2026-10-08

## Contexto

O roadmap pede painel administrativo com login por cookie httpOnly e permissões por papel. Em produção a loja fica na Vercel e a API no Render, em domínios diferentes: um cookie da API não seria enviado pelo navegador numa requisição cross-site com `SameSite=Strict`.

## Decisão

- **Sessão no servidor**, não JWT: tabela `admin_sessions` guarda só o **hash SHA-256** de um token aleatório de 32 bytes. Logout e revogação são imediatos.
- Cookie `otilc_admin`: `HttpOnly`, `SameSite=Strict`, `Secure` em produção, `Path=/api/admin`, validade de 8 horas.
- **O navegador fala com a API admin pela própria origem da loja**: o Next.js reescreve `/api/admin/:path*` para `${API_URL}/api/admin/:path*`. Assim o cookie é first-party e o CORS da API continua fechado.
- Proteção CSRF: `SameSite=Strict` + a API recusa requisições mutáveis (`POST`, `PATCH`, `PUT`, `DELETE`) em `/api/admin` cujo header `Origin` não seja `WEB_ORIGIN`.
- Senhas com `scrypt` (`node:crypto`), sal aleatório por usuário, comparação com `timingSafeEqual`. Sem dependência nova.
- Papéis: `OWNER` (tudo) e `STAFF` (consulta, estoque e status de pedido; não cria produto nem muda preço). Detalhado em "Ajustes da spec-001".
- Login com limite de tentativas mais baixo (5 por minuto por IP) e mensagem de erro genérica.
- Admin é criado por script de linha de comando (`npm run admin:create -w @otilc/api`), nunca por endpoint público.

## Consequências

- Não há cadastro público de admin; o primeiro usuário é criado localmente pelo dono.
- Sessões expiradas precisam ser limpas (pode reaproveitar o padrão do job de expiração de pedidos).
- Upload de fotos fica para outra ADR; por enquanto imagens são URLs.

## Ajustes da spec-001

Definições fechadas na revisão do contrato (`packages/shared/src/admin.ts`, `docs/api/admin.md`):

1. **E-mail normalizado, não recusado.** O `adminLoginSchema` aplica `trim` + minúsculas no e-mail antes de validar, então `Ana@Example.com` entra como `ana@example.com`. O banco continua com o `CHECK admin_users_email_lowercase` (`email = lower(email)`), e o script de criação de admin grava o e-mail já normalizado.
2. **Permissões explícitas por ação** (`AdminAction` + `canRole`):
   - `STAFF`: `product:read`, `order:read`, `stock:update`, `order:updateStatus`. Não cria produto, não edita **nenhum** campo de produto (inclusive preço) e não cria variação.
   - `OWNER`: todas as ações, inclusive `product:create`, `product:update` e `variant:create`.
