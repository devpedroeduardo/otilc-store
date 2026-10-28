# spec-016 — Deploy: API no Render, loja na Vercel, banco no Supabase

- Papel: `infra` + `seguranca` (Forja) e `docs` (Faísca) — ver docs/agents/roles/
- Agente sugerido: Forja (render.yaml, Dockerfile, SSL do banco, proteções de configuração) e Faísca (runbook e script de smoke). Revisão: Lente; segunda revisão pelo outro dev (Faísca revisa a parte da Forja e a Forja revisa a da Faísca). Sem especialista. O Pedro lê o diff inteiro.
- Depende de: spec-015 (mergeada em 0b71b59)
- Pode rodar em paralelo com: nada que toque em `apps/api/src/config/**`, `apps/api/src/db/client.ts`, `apps/api/Dockerfile` ou `apps/web/next.config.ts`
- Branch: `spec-016-deploy`. A Faísca trabalha em `spec-016-deploy-docs`, criada a partir do commit desta spec, e a Forja faz o merge dela na branch da spec antes do PR. Um PR só.

## Objetivo

O repositório traz tudo o que o Pedro precisa para publicar a API no Render e a loja na Vercel, com o banco no Supabase: um Blueprint `render.yaml`, um runbook passo a passo e um script de smoke test. Depois que o Pedro executa o runbook, a API e a loja estão no ar, o timer da conciliação roda, o deploy é automático no merge da `main` e a Formiga consegue rodar o smoke test.

## Contexto

- Decisões do Pedro: nota "Grilling Deploy" (fichário "Fluxo OTILC"), sim para as recomendações 1 a 3 e 5 a 13. Fatos do código: nota "Recon Deploy".
- **Regras desta spec.** Segredos e variáveis de produção só o Pedro coloca, direto nos painéis. Criar contas, conectar o GitHub e qualquer ação nos painéis do Render, da Vercel e do Supabase são do Pedro. Os agentes escrevem só arquivos de configuração, docs e código. Nenhum agente roda comando contra o Supabase, o Render ou a Vercel.
- Estado do banco de produção (consulta só leitura feita pelo Maestro): a tabela `drizzle.__drizzle_migrations` tem as migrações 0000 a 0003, com hashes iguais aos da `main`. As migrações 0004 e 0005 ainda não foram aplicadas e entram pelo Pre-Deploy Command do primeiro deploy. Não há registro manual de migração.
- O cookie de admin continua first-party pelo rewrite do Next.js (ADR 0002). A API já tem `trust proxy 1`.
- O painel de alertas é a spec-017.

## Contrato entre Forja e Faísca

A Faísca escreve o runbook a partir destes nomes. Mudou algum? A Forja avisa a Bússola antes.

- Serviço no Render: `otilc-api`, runtime Docker, `dockerfilePath: apps/api/Dockerfile`, contexto na raiz do repo, região `virginia`, 1 instância, sem autoscaling, `healthCheckPath: /api/health`, deploy automático depois do CI verde (`autoDeployTrigger: checksPass`), Pre-Deploy Command rodando o migrator.
- Variáveis da API declaradas no `render.yaml`:
  - sem valor no arquivo (`sync: false`, o Pedro preenche): `DATABASE_URL` (session pooler do Supabase), `DATABASE_CA_CERT`, `WEB_ORIGIN`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_NOTIFICATION_URL`;
  - com valor no arquivo: `NODE_ENV=production`. Os opcionais (`PORT`, `ORDER_HOLD_MINUTES`, `PAYMENT_RECONCILIATION_INTERVAL_MS`) ficam no padrão do código.
- `DATABASE_CA_CERT` (nova): conteúdo PEM do certificado raiz público do Supabase. Obrigatória com `NODE_ENV=production`; opcional fora dele.
- Loja na Vercel, configurada pelo painel: Root Directory `apps/web`, região das funções `iad1`, previews desligados, deploy automático na `main`. Variáveis: `API_URL` e `NEXT_PUBLIC_API_URL` (URL do Render), `NEXT_PUBLIC_ADMIN_MOCK` ausente.
- Smoke test: `scripts/smoke.sh <URL_DA_API> <URL_DA_LOJA>`, só leitura, sai com código diferente de zero na primeira falha.

## Como fazer

### Forja

1. **`render.yaml`** na raiz, conforme o contrato. Nenhum valor secreto no arquivo. Confira na documentação oficial do Render a sintaxe de `preDeployCommand`, `autoDeployTrigger`, `region` e `numInstances` e cite o link no PR. O plano pago é escolhido pelo Pedro no painel; se o Blueprint exigir o campo `plan`, use `starter` e deixe isso claro no PR.
2. **Migrações fora do start.** O `CMD` do Dockerfile passa a subir só a API. O migrator roda no Pre-Deploy Command, uma vez por deploy. Para o desenvolvimento local e o CI nada muda (`npm run db:migrate`).
3. **SSL do banco.** Em produção, o pool do `pg` usa SSL com verificação de certificado (`rejectUnauthorized: true`) e o CA de `DATABASE_CA_CERT`. Proibido desligar a verificação. O migrator usa a mesma configuração de conexão. Fora de produção, sem a variável, o comportamento local continua igual.
4. **Proteções de configuração.**
   - A API não sobe com `NODE_ENV=production` sem `WEB_ORIGIN` (https) ou sem `DATABASE_CA_CERT`, com mensagem clara e sem imprimir valores.
   - A loja falha no build da Vercel de produção (`VERCEL_ENV=production`) se `NEXT_PUBLIC_ADMIN_MOCK` estiver ligado. O build local e o `test:e2e:web` não são afetados.
5. Sessão do pooler: confirme que o `pg` com o session pooler do Supabase não precisa de ajuste (prepared statements, tamanho do pool de 10). Registre a conclusão no PR.

### Faísca

1. **`docs/deploy.md`**, o runbook do Pedro, em português, na ordem:
   1. Pré-requisitos: contas e o GitHub conectado (ações do Pedro).
   2. **Antes do primeiro deploy, conferência só leitura da tabela de controle do drizzle.** Uma consulta `SELECT` em `drizzle.__drizzle_migrations` no editor SQL do Supabase. O resultado esperado é 0000 a 0003 aplicadas e 0004 e 0005 não, com a orientação de parar e chamar a Bússola se o resultado for outro. Nenhum comando de escrita.
   3. Onde pegar a connection string do session pooler e o certificado raiz do Supabase, sem colar nenhum valor no doc.
   4. Aplicar o Blueprint no Render, preencher as variáveis do contrato e acompanhar o primeiro deploy (o Pre-Deploy aplica 0004 e 0005).
   5. Criar o projeto na Vercel pelo painel, com os ajustes do contrato.
   6. Voltar ao Render para preencher `WEB_ORIGIN` com a URL da Vercel, e configurar o webhook no painel do Mercado Pago para `<URL do Render>/api/webhooks/mercadopago` (credenciais de teste até o lançamento).
   7. Rodar o smoke test e o que fazer se ele falhar. Como reverter um deploy no Render e na Vercel.
2. **`scripts/smoke.sh`**: `GET /api/health` com 200, a home da loja com 200, uma página de produto com 200 (o slug vem da listagem pública da API) e a tela de login do admin carregando. Não cria pedido, não faz login, não envia segredo. Usa só `curl` e ferramentas POSIX, com `set -eu` e timeout por requisição.
3. README: marcar o item de deploy do Roadmap e apontar para `docs/deploy.md`.

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

Forja:

- `render.yaml` (novo)
- `apps/api/Dockerfile`
- `apps/api/src/db/client.ts`, `apps/api/src/db/migrate.ts`, `apps/api/src/db/database.module.ts` (só configuração de conexão e SSL)
- `apps/api/src/config/env.ts`, `apps/api/src/config/env.spec.ts`, `apps/api/.env.example`
- `apps/api/src/db/client.spec.ts` (novo, se precisar testar a configuração de SSL)
- `apps/web/next.config.ts`, `apps/web/src/lib/**` (só a proteção do `NEXT_PUBLIC_ADMIN_MOCK`), `apps/web/.env.example`, teste unitário dessa proteção ao lado do código
- `specs/016-deploy.md` (esta spec), `docs/agents/scorecard.md` (fechamento)

Faísca:

- `docs/deploy.md` (novo)
- `scripts/smoke.sh` (novo)
- `README.md` (só o item de deploy do Roadmap e o link para o runbook)

## Fora do escopo

- Qualquer ação nos painéis, criação de conta, preenchimento de segredo ou comando contra o Supabase, o Render ou a Vercel.
- Workflows do GitHub (`.github/workflows/**`). O deploy automático vem da integração do Render e da Vercel com o GitHub.
- Domínio próprio, ambiente de preview, autoscaling.
- Credenciais reais do Mercado Pago e o lançamento.
- Painel de alertas (spec-017).
- Mudança de schema ou migração.

## Critérios de aceite

- [ ] `render.yaml` conforme o contrato, sem nenhum valor secreto (todas as variáveis secretas com `sync: false`), com link da documentação oficial do Render no PR.
- [ ] A imagem Docker sobe a API sem rodar migração, e o Pre-Deploy Command roda o migrator. Verificado com `docker build` e `docker run` locais contra o Postgres do `docker compose`.
- [ ] Teste unitário: em produção, a configuração de conexão usa SSL com `rejectUnauthorized: true` e o CA de `DATABASE_CA_CERT`; fora de produção, sem a variável, fica como hoje. O migrator usa a mesma configuração.
- [ ] Teste em `env.spec.ts`: produção sem `WEB_ORIGIN` https ou sem `DATABASE_CA_CERT` falha, sem imprimir valores.
- [ ] Teste unitário: a proteção da loja barra `NEXT_PUBLIC_ADMIN_MOCK` ligado com `VERCEL_ENV=production` e deixa passar fora dele.
- [ ] `docs/deploy.md` traz os sete passos, incluindo a conferência só leitura da tabela de controle do drizzle antes do primeiro deploy, sem nenhum valor real de segredo, URL de conexão ou token.
- [ ] `scripts/smoke.sh` passa contra a API e a loja locais (`npm run dev`, com seed) e falha com código diferente de zero se a API estiver fora. A saída das duas execuções vai no PR.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` e `npm run test:e2e:web` verdes; `npm run build` verde.
- [ ] Scorecard: linha da 016.

## Notas para o revisor

- Nenhum segredo no `render.yaml`, no runbook ou nos testes. Exemplos usam valores obviamente fictícios.
- SSL com verificação ligada; qualquer `rejectUnauthorized: false` é bloqueador.
- A remoção da migração do `CMD` não pode deixar o desenvolvimento local nem o CI sem migração.
- O Pre-Deploy Command aplica 0004 e 0005 no primeiro deploy: confira que essas migrações são seguras com a loja já no ar (0004 cria tabelas de pagamento; 0005 adiciona valor de enum, tabela de alertas e índice).
- A proteção do mock do admin não pode quebrar o `test:e2e:web`.
