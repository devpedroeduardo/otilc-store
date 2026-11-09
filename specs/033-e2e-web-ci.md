# spec-033 — Suíte e2e web e smoke do docker-compose no CI

- Papel: infra (CI) — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code)
- Depende de: spec-025 (e2e do admin isolado), spec-026 (docker-compose), spec-027 (admin no compose)
- Pode rodar em paralelo com: nenhuma
- Branch: `spec-033-e2e-web-ci`

## Objetivo

O CI do GitHub Actions passa a rodar a suíte e2e web (Playwright, com `admin.spec.ts`) e a subir o docker-compose do projeto com um smoke da API e da loja. Um PR que quebre a suíte web ou o compose fica vermelho no CI. Isso fecha o risco aceito nas specs 025, 026 e 027 antes do 1º deploy.

## Contexto

- Decisões do Pedro (2026-11-09) na nota "Grilling e2e web CI" do fichário "Fluxo OTILC": as 16 recomendações aceitas, com um ajuste na Q5 (ver item 10 do Escopo). Fatos na nota "Recon e2e web CI", levantados pela Formiga em 5ff547f, só por leitura.
- `.github/workflows/ci.yml` roda em `push` na main e em todo `pull_request`, sem `paths`, com concorrência por ref e cancelamento. Tem os jobs `qualidade`, `integracao` (serviço `postgres:16-alpine`, banco `otilc_test`, usuário e senha `otilc`) e `build`, todos em `ubuntu-latest` com `cache: npm`. Não define `timeout-minutes` nem `permissions`. As actions estão fixadas por SHA com comentário de versão.
- Hoje o CI leva ~2 min. Nenhum job roda `npm run test:e2e:web` nem sobe o compose.
- `npm run test:e2e:web` (raiz) faz o build do shared, compila `e2e/tsconfig.json` e roda `playwright test`. A config usa só chromium, 1 worker, `retries: 0`, `forbidOnly` em CI e reporter `list` + `html` em `e2e/.results/report`. Os `webServer` sobem a API com `tsx` na porta 3336 (roda as migrações) e a loja com `next dev` na porta 3006.
- O banco do e2e web é `otilc_test_e2e`, lido de `E2E_DATABASE_URL`. A guarda recusa host que não seja local e nome sem o prefixo `otilc_test`. O `globalSetup` migra, roda o seed, limpa admins, sessões e alertas e cria um OWNER e um STAFF com senha de `randomBytes`, guardada só em `process.env`.
- Specs do e2e web: `admin.spec.ts`, `admin-alerts.spec.ts`, `compra.spec.ts` e `pedido-pix.spec.ts` (Pix simulado com `page.route` e `page.clock`).
- O `docker-compose.yml` tem `db` (com healthcheck), `migrate`, `seed` (profile `seed`), `api` (healthcheck em `/api/health`, porta 3333) e `web` (porta 3000, sem healthcheck, depende da `api` saudável). Só usa valores locais fictícios, sem `env_file`. `MP_*` e `DATABASE_CA_CERT` só são exigidos em produção, e o compose usa `NODE_ENV=development`.
- A spec-027 registrou que o Playwright roda `next dev` e por isso não pega defeito de build arg (`API_URL`) na imagem da web. O `API_URL` de build só afeta o rewrite de `/api/admin/*` (`apps/web/next.config.ts:17`); a home é `force-dynamic` e lê o `API_URL` de runtime. Por isso o smoke do compose cobre o caso pela rota `GET /api/admin/me` da loja (item 6), e as outras rotas não pegam o defeito (medição da Forja, 2026-11-09, no Log da nota da spec).
- Nenhuma credencial real é necessária para a suíte web nem para o compose. O repositório é público, então os minutos do Actions em runner padrão não são cobrados.
- Estimativas da Formiga, sem medição: job e2e web de 6 a 12 min; `docker compose build` de 10 a 18 min sem cache de camadas e de 2 a 4 min com cache GHA.

## Escopo

1. Dois jobs novos em `.github/workflows/ci.yml`, `e2e-web` e `compose`, sem `needs`, rodando em paralelo aos atuais. Mesmo gatilho e mesma concorrência do workflow: todo PR e todo push na main, sem filtro de `paths`.
2. Os dois jobs usam `ubuntu-latest`, `permissions: contents: read` e `timeout-minutes` de 20 (`e2e-web`) e 25 (`compose`).
3. Nenhum segredo: zero `secrets.*`, zero `env_file` e nenhuma variável `MP_*` nos jobs novos. Só valores de teste inline: Postgres `otilc`/`otilc` como no job `integracao`, banco `otilc_test_e2e` e as senhas de admin que o `globalSetup` gera na hora.
4. Job `e2e-web`: serviço `postgres:16-alpine` no próprio job, com `POSTGRES_DB=otilc_test_e2e` e `E2E_DATABASE_URL` no `env` do job. Instala o chromium com `npx playwright install --with-deps chromium` e guarda `~/.cache/ms-playwright` em cache pela versão do Playwright; no acerto do cache roda só `npx playwright install-deps chromium`. Depois roda `npm run test:e2e:web`.
5. Em falha do `e2e-web`, `actions/upload-artifact` sobe `e2e/.results/report` com retenção de 7 dias. Nada sobe quando o job passa.
6. Job `compose`: `docker compose up -d --build --wait`, depois `docker compose --profile seed run --rm seed`, e então `curl` com falha em resposta diferente de 200 em `http://localhost:3333/api/health`, em `http://localhost:3000/` (o HTML precisa conter o nome de um produto do seed) e em `http://localhost:3000/admin/login`. Um 4º `curl` faz `GET http://localhost:3000/api/admin/me` sem cookie e espera 401 vindo da API pelo rewrite; qualquer outro status (500 com o `API_URL` de build errado, por exemplo) falha o job. Sem login e sem credencial. O `curl` tenta de novo por até ~60 s. Em falha, o job imprime `docker compose logs`. No fim, sempre, `docker compose down -v`. Login de admin no compose fica fora; a suíte web cobre esse fluxo.
7. Cache das imagens: a Forja tenta cache GHA de camadas sem alterar `docker-compose.yml` nem os Dockerfiles. Se não der sem mexer neles, fica o build frio, dentro do timeout de 25 min. A Forja registra na nota da spec qual saída usou.
8. Ações novas (cache, upload-artifact, buildx ou bake, se usadas) seguem o formato do `ci.yml`: fixadas por SHA com comentário de versão.
9. Tempo medido: a Forja registra na nota da spec a duração de cada job novo com cache frio e com cache quente. Se o CI com cache quente passar de 15 min de relógio, a Forja para e a Bússola leva ao Pedro antes do merge.
10. Passo do Pedro depois do merge: hoje a main não tem proteção de branch. O Pedro cria a regra de proteção da main no painel do GitHub e marca como obrigatórios todos os checks: os 6 atuais de CI e Segurança, mais `e2e-web` e `compose`. Nenhum agente toca no painel; o corpo do PR lista esse passo.
11. `README.md`: a parte de CI e o Roadmap passam a dizer que o CI roda a suíte e2e web e o smoke do compose, e o risco aceito das 025, 026 e 027 deixa de constar onde o README o citar.
12. Linha 032 do scorecard em commit separado, copiada da seção "Dados da linha 032 do scorecard" da nota "spec-032 Sobra 029", com uso "~3% da semana", sem mudar nenhum campo.

## Arquivos permitidos

- `.github/workflows/ci.yml` (esta spec autoriza a mudança em workflow, como exige o AGENTS.md)
- `README.md` (só o trecho do item 11)
- `docs/agents/scorecard.md` (só a linha 032 e o realinhamento que o Prettier exigir)
- `specs/033-e2e-web-ci.md`

A Forja para e avisa a Bússola, sem ampliar a spec, em qualquer um destes casos:

- a suíte web ou o compose só passa no CI mexendo em arquivo fora da lista, inclusive quando o CI revela um bug real no código, no `playwright.config.ts`, no `e2e/**`, no `docker-compose.yml` ou num Dockerfile;
- a suíte falha no runner por lentidão do `next dev` e a saída seria mudar timeout;
- algum passo pede segredo, `env_file`, variável `MP_*` ou credencial real;
- o tempo do item 9 passa de 15 min com cache quente;
- o código de 5ff547f contradiz o que está em Contexto.

## Fora do escopo

- `.github/workflows/security.yml`, `playwright.config.ts`, `e2e/**`, `docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/**`, `packages/**`, qualquer `.env*`.
- Healthcheck novo na `web` do compose, trocar `next dev` por build de produção no Playwright, retry na suíte e mais workers.
- Filtro de `paths` nos jobs novos.
- Login de admin no smoke do compose.
- Proteção de branch, painéis (GitHub, Render, Supabase, Mercado Pago), segredos, deploy e produção, que são do Pedro. Credenciais não passam por agentes.

## Prova de aceite

A prova de que o CI fica vermelho sai de um PR rascunho descartável, criado a partir da branch da spec, com duas sabotagens em commits separados:

- (a) uma asserção do `e2e/admin.spec.ts` quebrada: o job `e2e-web` fica vermelho;
- (b) um `API_URL` errado no build da web: o job `compose` fica vermelho.

O PR rascunho é fechado sem merge e a branch dele é apagada. Os links das duas execuções vermelhas vão para a nota da spec e para o corpo do PR real. O PR real termina com todos os checks verdes.

## Critérios de aceite

- [ ] Jobs `e2e-web` e `compose` no `ci.yml`, verdes no PR real, rodando em paralelo aos atuais, sem `paths`, com `permissions: contents: read` e os timeouts do item 2.
- [ ] `e2e-web` roda `npm run test:e2e:web` com as 4 specs, incluindo `admin.spec.ts`, e sobe o relatório só em falha.
- [ ] `compose` faz o smoke das quatro rotas do item 6, com o produto do seed na home e o 401 em `/api/admin/me`, e sempre derruba o compose no fim.
- [ ] Busca por `secrets.`, `env_file` e `MP_` nos jobs novos sem resultado; gitleaks e Semgrep verdes.
- [ ] Ações novas fixadas por SHA com comentário de versão.
- [ ] Provas (a) e (b) vermelhas no PR rascunho, com os links na nota da spec e no corpo do PR.
- [ ] Tempos frio e quente de cada job novo e a saída de cache do item 7 registrados na nota da spec.
- [ ] Corpo do PR lista o passo do Pedro (item 10).
- [ ] Linha 032 do scorecard conforme o item 12.
- [ ] `git diff main --stat` só mostra arquivos permitidos.
- [ ] Corpo do PR, corpos dos commits e texto novo do README passaram pelo humanizer.
- [ ] `npm run format:check && npm run typecheck && npm test` verdes localmente; CI completo verde.

## Notas para o revisor

- Revisão da Lente e 2ª revisão da Faísca, porque o PR mexe em segurança do CI (permissões, ações de terceiros, ausência de segredos). O Pedro lê o diff do workflow.
- Conferir que nenhum job novo lê segredo, que as senhas de admin continuam só em memória e que o artefato de falha não leva nada além do relatório do Playwright.
- Conferir que os jobs existentes (`qualidade`, `integracao`, `build`) e o `security.yml` não mudaram.
- Os tempos de CI são os medidos pela Forja; as estimativas do reconhecimento não valem como prova.
- Sem deploy no fechamento desta spec, então sem smoke pós-merge.
