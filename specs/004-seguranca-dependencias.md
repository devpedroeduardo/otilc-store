# spec-004 — Vulnerabilidades de dependências e trava da seed

- Papel: `seguranca`
- Agente sugerido: terceiro agente (OpenCode, Copilot CLI ou Cursor) — bom para comparar com os outros
- Depende de: nenhuma
- Pode rodar em paralelo com: spec-002, spec-003 (atenção: se a 003 mexer no `package-lock.json` ao mesmo tempo, quem fizer merge depois refaz o `npm install`)
- Branch: `spec-004-seguranca-dependencias`

## Objetivo

Zerar as vulnerabilidades **altas** das dependências de produção e impedir que a seed (que faz `TRUNCATE` em tudo) rode fora de um banco local.

## Contexto

`npm audit --omit=dev --audit-level=high` falha hoje com:

- `drizzle-orm` < 0.45.2 — SQL injection via identificadores mal escapados (GHSA-gpj5-g38j-94v9). Correção: subir para a 0.45.x mais recente (e o `drizzle-kit` compatível).
- `postcss` (dependência do `next`) — várias falhas de source map e XSS no stringify. Avalie: atualização do Next dentro da linha 15 que já traga postcss corrigido; se não existir, `overrides` do npm fixando `postcss` corrigido. **Não** suba o Next para 16 nesta spec.

`apps/api/src/db/seed.ts` apaga todas as tabelas. Hoje nada impede rodar com um `DATABASE_URL` de produção.

## Arquivos permitidos

- `package.json` (raiz, apenas `overrides` se necessário), `package-lock.json`
- `apps/api/package.json`, `apps/web/package.json` (apenas versões)
- `apps/api/src/db/seed.ts` e um novo `apps/api/src/db/seed.spec.ts`
- Ajustes mínimos em `apps/api/src/**` **somente** se a nova versão do Drizzle quebrar tipos ou API (explique cada um no PR)
- `.github/workflows/security.yml` (somente para remover o `continue-on-error` do job de dependências quando ele passar)

## Fora do escopo

- Atualizar outras dependências "de carona".
- Next 16, mudanças de comportamento da loja.

## Critérios de aceite

- [ ] `npm audit --omit=dev --audit-level=high` sem achados
- [ ] Seed recusa rodar (erro claro, sem apagar nada) quando o host do banco não é `localhost`, `127.0.0.1` ou `db` (serviço do docker compose); teste unitário cobrindo os três casos permitidos e um proibido
- [ ] A trava é testável sem banco (função pura que recebe a URL)
- [ ] `test/setup.ts` continua funcionando (o banco de teste é local)
- [ ] Job "Dependências" do `security.yml` passa e deixa de ser `continue-on-error`
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e && npm run build` verdes
- [ ] PR lista: versão antiga → nova de cada pacote e o link de changelog consultado

## Notas para o revisor

- Rode o teste de concorrência de pedidos localmente depois do upgrade do Drizzle: é onde uma mudança de comportamento doeria mais.
