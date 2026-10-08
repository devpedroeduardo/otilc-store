# ADR 0002 — Autenticação do painel administrativo

- Status: proposto (aprovar no merge da spec-001)
- Data: 2026-10-08

## Contexto

O roadmap pede painel administrativo com login por cookie httpOnly e permissões por papel. Em produção a loja fica na Vercel e a API no Render, em domínios diferentes: um cookie da API não seria enviado pelo navegador numa requisição cross-site com `SameSite=Strict`.

## Decisão

- **Sessão no servidor**, não JWT: tabela `admin_sessions` guarda só o **hash SHA-256** de um token aleatório de 32 bytes. Logout e revogação são imediatos.
- Cookie `otilc_admin`: `HttpOnly`, `SameSite=Strict`, `Secure` em produção, `Path=/api/admin`, validade de 8 horas.
- **O navegador fala com a API admin pela própria origem da loja**: o Next.js reescreve `/api/admin/:path*` para `${API_URL}/api/admin/:path*`. Assim o cookie é first-party e o CORS da API continua fechado.
- Proteção CSRF: `SameSite=Strict` + a API recusa requisições mutáveis (`POST`, `PATCH`, `PUT`, `DELETE`) em `/api/admin` cujo header `Origin` não seja `WEB_ORIGIN`.
- Senhas com `scrypt` (`node:crypto`), sal aleatório por usuário, comparação com `timingSafeEqual`. Sem dependência nova.
- Papéis: `OWNER` (tudo) e `STAFF` (consulta, estoque e status de pedido; não cria produto nem muda preço).
- Login com limite de tentativas mais baixo (5 por minuto por IP) e mensagem de erro genérica.
- Admin é criado por script de linha de comando (`npm run admin:create -w @otilc/api`), nunca por endpoint público.

## Consequências

- Não há cadastro público de admin; o primeiro usuário é criado localmente pelo dono.
- Sessões expiradas precisam ser limpas (pode reaproveitar o padrão do job de expiração de pedidos).
- Upload de fotos fica para outra ADR; por enquanto imagens são URLs.
