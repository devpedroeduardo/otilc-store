# spec-027 — painel admin funcionando no docker compose

- Papel: infra — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code)
- Depende de: spec-026 (mergeada em 88cae28)
- Pode rodar em paralelo com: nenhuma
- Branch: `spec-027-admin-compose`

## Objetivo

A partir de um clone limpo, `docker compose up --build` sobe tudo, o login e as telas do `/admin` respondem sem 500 e a loja continua respondendo. O deploy não muda de comportamento.

## Contexto

- Decisões do Pedro (2026-11-04) na nota "Grilling admin compose" do fichário "Fluxo OTILC", 13 recomendações sem ajuste. Fatos na nota "Recon admin compose", levantados em 88cae28 só por leitura.
- `apps/web/next.config.ts:17` monta o rewrite de `/api/admin/:path*` com `API_URL ?? http://localhost:3333`, e o `next build` grava o destino em `required-server-files.json`. O estágio de build de `apps/web/Dockerfile` não recebe `API_URL` (`:3-4,11`), então o rewrite aponta para localhost dentro do contêiner da web. O `API_URL: http://api:3333` de `docker-compose.yml:93` só vale em runtime.
- Passam pelo rewrite o login, `me`, `logout` e as mutações do navegador (`apps/web/src/lib/admin-api.ts:49-53,65,72-130`). As chamadas server-side com cookie usam `API_URL` de runtime.
- O status 500 ainda não foi medido: veio da leitura.
- `render.yaml:9-13` usa só `apps/api/Dockerfile`. A loja vai pela Vercel com Root Directory `apps/web`, sem Docker, e executa `next.config.ts` no próprio build. Por isso a correção fica no Dockerfile da web e no compose.
- `apps/web/Dockerfile` só é usado por `docker-compose.yml:89`.
- O seed não cria admin (`apps/api/src/db/seed.ts:4,58-105`). `apps/api/src/scripts/create-admin.ts:20-22` exige TTY, e o compilado está na imagem da api.

## Escopo

1. Reproduzir o defeito em 88cae28 antes de corrigir, com `-p otilc-forja027` e as portas trocadas por um override fora do repositório, como na 026. Registrar o status medido na nota da spec.
2. `apps/web/Dockerfile`: `ARG API_URL=http://localhost:3333` no estágio de build, disponível para o `next build`, seguindo o padrão de `NEXT_PUBLIC_API_URL`. O default evita string vazia, que o `??` de `next.config.ts:17` não trata. O estágio final fica sem `API_URL`, que segue vindo do `environment` do compose.
3. `docker-compose.yml`: `API_URL: http://api:3333` em `build.args` do serviço `web`, mantendo o `environment` atual.
4. Confirmar build com exit 0 com a API fora do ar. `lib/api.ts:13,25` também lê `API_URL`, e no build o host `api` não resolve.
5. README, seção do compose (`README.md:94-103`): trocar a frase da linha 103 pelo fluxo de criar admin e logar, usando o script compilado na imagem da api. Ponto de partida do comando, com o caminho a confirmar: `docker compose run --rm api node /repo/apps/api/dist/scripts/create-admin.js`. Sem serviço novo e sem mudar `src`.
6. Linha 026 do scorecard, copiada da nota "spec-026 docker-compose", com uso "não informado", em commit separado. O texto fica idêntico; se o `format:check` exigir, a tabela é realinhada e o diff cresce.

## Arquivos permitidos

- `apps/web/Dockerfile`
- `docker-compose.yml`
- `README.md` (só a seção do compose, linhas 94-103)
- `docs/agents/scorecard.md` (só a linha 026 e o realinhamento que o Prettier exigir)
- `specs/027-admin-compose.md`

A Forja para e avisa a Bússola, sem ampliar a spec, em qualquer um destes casos:

- a causa medida é outra, ou existe um segundo defeito fora dos arquivos permitidos (por exemplo no `Origin`, `apps/api/src/admin-auth/admin-origin.middleware.ts:20-24`);
- o build falha ou alguma página sai diferente com `API_URL` no build;
- o script de criar admin recusa rodar pelo `docker compose run`;
- a reprodução mostra que o EACCES em `.next/cache` causa 500.

## Fora do escopo

- `apps/web/next.config.ts`, `render.yaml`, `apps/api/Dockerfile`, `.github/workflows/**`, qualquer `src`, `docs/deploy.md`, `packages/shared` e migrações.
- Serviço de admin no compose e admin semeado.
- Teste automatizado novo e compose no CI. O PR registra a dispensa de forma explícita: a mudança é um ARG e um build arg, sem regra de negócio, e a evidência é a prova da Formiga. O risco aceito é o defeito voltar sem alarme, porque o Playwright roda com `next dev` e não reproduz o build do Dockerfile.
- EACCES em `.next/cache` e `up --build` que não reconstrói a imagem do seed.
- CORS em `apps/api/src/bootstrap.ts:14` em relação ao ADR 0002.
- Deploy, segredos, painéis e produção.

## Prova de aceite

Quem roda é a Formiga, num clone limpo do head do PR. A Forja não para nem derruba nada do projeto `otilc-store` durante o desenvolvimento.

1. Confere 3333 e 3000. Se alguma estiver ocupada, para, registra na nota da spec e marca 🔴, sem parar nada.
2. Na raiz `/home/devpedroeduardo/otilc-store`, roda `docker compose stop db` e confere que a 5432 ficou livre. Se continuar ocupada, trata como o passo 1 e já executa o passo 8.
3. No clone, roda `docker compose -p otilc-smoke up --build -d`, espera a `api` ficar healthy e roda `docker compose -p otilc-smoke run --rm seed`.
4. Com senha errada e sem admin, o login em `:3000` (rota de `adminApi.login`, que a Forja informa no PR) devolve 401 vindo da API, sem 500.
5. Cria um admin com `*@example.test` e senha gerada na hora com prefixo `teste-`, pelo comando do README. A senha não aparece em log nem no PR. O login dá certo e o cookie é emitido.
6. Em `:3000`, com o cookie, confere 200 em `/admin`, `/admin/products/new`, `/admin/products/[id]`, `/admin/orders`, `/admin/orders/[id]` e `/admin/alerts`. Sem cookie, as telas protegidas redirecionam e `/admin/login` dá 200. Uma mutação pelo rewrite, com `Origin: http://localhost:3000`, responde sucesso. Para ter `/admin/orders/[id]`, cria um pedido pela API; se o Pix desligado impedir, registra essa tela como não verificada e avisa a Bússola.
7. A loja `/` responde 200 com os 17 produtos do seed e `/api/health` responde 200. No fim, roda `docker compose -p otilc-smoke down -v`.
8. Passando ou falhando, roda `docker compose start db` na raiz e confirma `otilc-store-db-1` Up (healthy).

No projeto `otilc-store` valem só `stop db` e `start db`, nunca `down`, `rm` ou remoção de volume. `down -v` e `run --rm` valem só para `-p otilc-smoke`. Logs ficam fora do git e sem senha.

## Critérios de aceite

- [ ] Status do defeito em 88cae28 medido e registrado na nota da spec.
- [ ] A prova acima passa e a saída vai para o PR.
- [ ] `otilc-store-db-1` volta a Up (healthy) depois da prova.
- [ ] Build da web com exit 0 com a API fora do ar.
- [ ] `git diff main --stat` só mostra arquivos permitidos.
- [ ] Linha 026 do scorecard idêntica à da nota.
- [ ] Dispensa de teste automatizado explícita no corpo do PR.
- [ ] Corpo do PR, corpos dos commits e texto do README passaram pelo humanizer.
- [ ] `npm run format:check && npm run typecheck && npm test` verdes; CI verde. `npm run test:e2e` não é exigido, porque a API não muda.

## Notas para o revisor

- Conferir que `apps/web/next.config.ts`, `render.yaml`, `apps/api/Dockerfile`, `.github/workflows/**` e `src` ficaram intocados.
- Conferir que `API_URL` não chega ao estágio final de `apps/web/Dockerfile` e que o `ARG` tem default.
- Conferir que nenhuma credencial entrou no README, no compose ou na saída colada no PR.
- O CI não cobre o compose. A evidência é a saída da prova da Formiga no PR.
