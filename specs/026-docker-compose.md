# spec-026 — docker compose completo a partir de um clone limpo

- Papel: infra — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code)
- Depende de: spec-025 (mergeada em ff4023c)
- Pode rodar em paralelo com: nenhuma
- Branch: `spec-026-docker-compose`

## Objetivo

A partir de um clone limpo e dos `.env.example`, `docker compose up --build` sobe `db`, `migrate`, `api` e `web`, com a `api` healthy e `/api/health` respondendo 200. O README ensina esse caminho.

## Contexto

- Decisões do Pedro (2026-11-02) na nota "Grilling docker-compose" do fichário "Fluxo OTILC", 12 recomendações mais o ajuste da 10. Fatos na nota "Recon docker-compose" (levantados em main 7be8ddb; confira as linhas em ff4023c).
- A API recusa subir pelo compose desde a spec-014: `apps/api/Dockerfile:14` fixa `NODE_ENV=production`, `apps/api/src/config/env.ts:42-61` exige em produção `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `DATABASE_CA_CERT` e `WEB_ORIGIN` https, e `docker-compose.yml:24-27` não passa nada disso.
- O compose não migra. Sem tabelas, `/api/health` responde 503 (`apps/api/src/health/health.controller.ts:11-18`).
- O `apps/api/Dockerfile` é o mesmo que o Render usa, e a migração de produção é o Pre-Deploy do Render (`render.yaml:21`). Por isso a correção fica só no compose.
- O seed trunca tudo, inclusive pedidos (`apps/api/src/db/seed.ts:61`).
- Ponto de partida: corpo do PR #28, `NODE_ENV: development` na `api` e um serviço `migrate` de execução única (`node /repo/apps/api/dist/db/migrate.js`).

## Escopo

1. Serviço `api`: `NODE_ENV: development` no compose. Pix fica desligado, como no `npm run dev`.
2. Serviço `migrate`: mesma imagem da `api`, roda o `migrate.js` compilado, `restart: "no"`. A `api` depende dele com `condition: service_completed_successfully`, e ele depende do `db` healthy.
3. Serviço `seed` atrás de `profiles: ["seed"]`, rodado só com `docker compose run --rm seed`. O `up` nunca semeia.
4. Healthcheck na `api` em `/api/health`, de preferência com `node -e fetch`, sem pacote novo na imagem. A `web` depende da `api` com `condition: service_healthy`.
5. Variáveis inline no compose, só com os valores fictícios e locais que já existem nos `.env.example`, sem `env_file`. Se faltar variável nos exemplos, atualize o exemplo.
6. Portas fixas 5432, 3333 e 3000, e o volume `pgdata` sem mudança. Nada de `container_name` fixo, para `-p otilc-smoke` não colidir com o projeto `otilc-store`.
7. README, seção "Como rodar": troca a linha do `up --build` pelo fluxo novo, com o seed opcional e o aviso de que ele apaga dados, Pix desligado e "não rode junto com `npm run dev`", por causa das portas.
8. Linha 025 do scorecard, copiada da nota "spec-025 E2E admin isolado" (uso "não informado"), em commit separado.

## Arquivos permitidos

- `docker-compose.yml`
- `README.md` (só a seção "Como rodar")
- `apps/api/.env.example` e `apps/web/.env.example` (só se faltar variável)
- `specs/026-docker-compose.md`
- `docs/agents/scorecard.md` (só a linha 025)

Se o `migrate.js`, o seed compilado ou os SQL de migração não estiverem na imagem final, ou se o build da `web` precisar da API no ar, a Forja para e avisa a Bússola. Mexer no Dockerfile está fora desta spec.

## Fora do escopo

- `apps/api/Dockerfile`, `apps/web/Dockerfile`, `render.yaml`, `.github/workflows/**` e qualquer `src`.
- `docs/deploy.md` e `scripts/smoke.sh`, que são de produção.
- Produção fake com tokens e CA fictícios.
- Portas variáveis.
- Compose ou build no CI.
- Deploy, Render, segredos e produção.

## Prova de aceite

Quem roda é a Formiga, dentro do limite definido pelo Pedro. A Forja não para nem derruba nada do projeto `otilc-store` durante o desenvolvimento: `docker compose config` e `build` bastam, e um `up` só com outro nome de projeto e com as portas trocadas por um override fora do repositório.

1. Confere 3333 e 3000. Se alguma estiver ocupada, para, registra na nota da spec e marca 🔴, sem parar nada.
2. Na raiz `/home/devpedroeduardo/otilc-store`, roda `docker compose stop db` e confere que a 5432 ficou livre. Se continuar ocupada, trata como o passo 1 e já executa o passo 5.
3. Num clone limpo do head do PR, roda `docker compose -p otilc-smoke up --build -d` e espera a `api` ficar healthy.
4. Confere `docker compose -p otilc-smoke ps`, com o `migrate` encerrado em exit 0, e `curl` em `/api/health` respondendo 200 e na loja em `:3000`. Roda `docker compose -p otilc-smoke run --rm seed`, repete o `up -d` e confere que o catálogo continua populado. No fim, roda `docker compose -p otilc-smoke down -v`.
5. Passando ou falhando, roda `docker compose start db` na raiz e confirma `otilc-store-db-1` Up (healthy).

No projeto `otilc-store` valem só `stop db` e `start db`, nunca `down`, `rm` ou remoção de volume. O `down -v` vale só para `-p otilc-smoke`.

## Critérios de aceite

- [ ] A prova acima passa e a saída vai para o PR.
- [ ] `otilc-store-db-1` volta a Up (healthy) depois da prova.
- [ ] `docker compose -p otilc-smoke run --rm seed` popula o catálogo, e um novo `up` não apaga dados.
- [ ] `git diff main --stat` só mostra arquivos permitidos; diff do scorecard = +1 linha (a 025).
- [ ] Corpo do PR e corpos dos commits passaram pelo humanizer.
- [ ] `npm run format:check && npm run typecheck && npm test` verdes; CI verde.

## Notas para o revisor

- Conferir que `apps/api/Dockerfile`, `apps/web/Dockerfile`, `render.yaml` e `.github/workflows/**` ficaram intocados.
- Conferir que o compose só tem valores fictícios e locais, sem `env_file` e sem segredo.
- Conferir que o `seed` não sobe em `docker compose up` sem o profile.
- O CI não cobre o compose. A evidência é a saída da prova da Formiga no PR.
