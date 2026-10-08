# spec-006 — Painel ligado na API + testes E2E com Playwright

- Papel: `frontend`
- Agente sugerido: Claude Code ou Codex
- Depende de: spec-003, spec-005, spec-007
- Pode rodar em paralelo com: nada
- Branch: `spec-006-integracao-admin-e2e`

## Objetivo

Ligar o painel na API real e cobrir com Playwright o fluxo de compra (item do roadmap) e o fluxo do administrador.

## Arquivos permitidos

- `apps/web/src/lib/admin-api.ts` (apenas correções de integração)
- `e2e/**`, `playwright.config.ts` na raiz
- `package.json` da raiz (script `test:e2e:web` e devDependency `@playwright/test`), `package-lock.json`

## Fora do escopo

- Mudar contrato, schema, regras de negócio ou `.github/`. Achou divergência entre API e web? Liste no PR e corrija só do lado do web; se o problema for da API, pare e reporte.

## Critérios de aceite

- [ ] Compra: abrir catálogo → filtrar categoria → abrir produto → adicionar ao carrinho → finalizar → ver pedido com estoque reservado
- [ ] Peça vendida aparece em cinza no fim da grade
- [ ] Admin: login → mudar estoque → cancelar pedido → unidade volta a ficar disponível na loja
- [ ] Mutação do painel pela API real (ex.: mudar estoque) **não** recebe 403 do CSRF: confirma que o rewrite do Next repassa o header `Origin` da loja. Se não repassar, pare e reporte (é decisão de contrato)
- [ ] Admin: acessar `/admin` sem sessão redireciona para login; STAFF não vê campo de preço
- [ ] Os testes criam o admin de teste programaticamente (sem senha fixa em arquivo versionado — gere na hora)
- [ ] `npm run test:e2e:web` verde localmente com `docker compose up -d db`, migração e seed
- [ ] PR com a lista de divergências encontradas entre API e web (mede se o paralelismo funcionou)
