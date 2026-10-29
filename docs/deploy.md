# Runbook de deploy

API no **Render**, loja na **Vercel**, banco no **Supabase** (us-east-1). Este documento é o passo a passo do Pedro: tudo o que mexe em painel, conta ou segredo é feito por você, na ordem abaixo. Os agentes só escrevem arquivos de configuração e docs.

> **Nunca cole segredo, URL de conexão ou token neste documento, em commit, em issue ou em chat.** Valores reais só vão direto nos painéis. Os exemplos abaixo são fictícios.

## O que vai para onde

| Peça      | Onde         | Como é configurada                                                         |
| --------- | ------------ | -------------------------------------------------------------------------- |
| API       | Render       | Blueprint `render.yaml` (serviço `otilc-api`, Docker, região `virginia`)   |
| Loja      | Vercel       | Painel (Root Directory `apps/web`, funções em `iad1`, previews desligados) |
| Banco     | Supabase     | Já existe; a API entra pelo **session pooler**                             |
| Pagamento | Mercado Pago | Credenciais de **teste** até o lançamento                                  |

Deploy automático: a API publica sozinha depois que o CI da `main` fica verde (`checksPass`); a loja publica a cada merge na `main`. As migrações rodam no **Pre-Deploy Command** do Render, uma vez por deploy, e não mais ao subir o container. Migração com erro cancela o deploy e a versão anterior continua no ar.

## 1. Pré-requisitos (ações do Pedro)

- [ ] Conta no Render com plano pago (o Pre-Deploy Command exige) e o GitHub conectado ao repositório `otilc-store`.
- [ ] Conta na Vercel com o GitHub conectado ao mesmo repositório.
- [ ] Acesso ao projeto Supabase de produção.
- [ ] Conta de desenvolvedor no Mercado Pago, com as **credenciais de teste**: `MP_ACCESS_TOKEN` e a assinatura secreta do webhook (`MP_WEBHOOK_SECRET`).
- [ ] A PR da spec-016 mergeada na `main` (é ela que traz `render.yaml`, o Dockerfile ajustado e a proteção de configuração).

## 2. Antes do primeiro deploy: conferir a tabela de controle do drizzle (só leitura)

O drizzle guarda quais migrações já rodaram em `drizzle.__drizzle_migrations`. Confira que ela está como esperado antes de deixar o Pre-Deploy mexer no banco.

1. Supabase → projeto de produção → **SQL Editor**.
2. Rode **somente** esta consulta (um `SELECT`; nenhum comando de escrita):

   ```sql
   SELECT id, hash, created_at
   FROM drizzle.__drizzle_migrations
   ORDER BY id;
   ```

3. Resultado esperado: **4 linhas**, as migrações `0000` a `0003`, com o `created_at` igual ao `when` de cada entrada de `apps/api/drizzle/meta/_journal.json` e o `hash` igual ao sha256 do SQL correspondente na `main`. As migrações `0004` e `0005` **não** estão na tabela: o Pre-Deploy do primeiro deploy as aplica.
4. **Se o resultado for outro** (menos de 4 linhas, linhas a mais, `0004`/`0005` já presentes, tabela inexistente): **pare aqui**, não faça o deploy e chame a Bússola. Não tente corrigir a tabela na mão.

## 3. Pegar a connection string do pooler e o certificado do Supabase

Você vai colar estes dois valores só no painel do Render (passo 4). Não os salve em arquivo.

- **`DATABASE_URL`**: Supabase → **Connect** (ou Project Settings → Database) → connection string do **Session pooler** (host `…pooler.supabase.com`, porta `5432`). Preencha a senha do banco no lugar do marcador. O formato é este, com valores fictícios:

  ```
  postgresql://postgres.PROJECT_REF:SENHA_DO_BANCO@aws-0-us-east-1.pooler.supabase.com:5432/postgres
  ```

  Use o session pooler (não a conexão direta nem o transaction pooler): a API usa pool de 10 conexões e o migrator precisa de sessão.

- **`DATABASE_CA_CERT`**: Supabase → Project Settings → Database → **SSL Configuration** → baixe o **certificado raiz (Root CA)**. Abra o arquivo `.crt` em um editor de texto e copie o conteúdo inteiro, de `-----BEGIN CERTIFICATE-----` até `-----END CERTIFICATE-----`. É um certificado público, mas a API só sobe em produção se ele estiver presente, e a conexão com o banco só é aceita se o certificado do servidor bater com ele.

## 4. Aplicar o Blueprint no Render e acompanhar o primeiro deploy

1. Render → **New** → **Blueprint** → escolha o repositório `otilc-store` e a branch `main`. O Render lê o `render.yaml` da raiz e propõe o serviço **`otilc-api`** (Docker, `apps/api/Dockerfile`, contexto na raiz, região Virginia, 1 instância, health check em `/api/health`).
2. Escolha o plano pago no painel; sem escolha, o Render usa `0.5c-512mb`.
3. Preencha as variáveis marcadas como "sem valor" (`sync: false`) direto no painel:

   | Variável              | O que colocar                                                                                                               |
   | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
   | `DATABASE_URL`        | Connection string do session pooler (passo 3)                                                                               |
   | `DATABASE_CA_CERT`    | Conteúdo PEM do certificado raiz do Supabase (passo 3)                                                                      |
   | `WEB_ORIGIN`          | Por ora, `https://placeholder.example.com`: o valor real entra no passo 6. Até lá, o login do admin não funciona            |
   | `MP_ACCESS_TOKEN`     | Access token de **teste** do Mercado Pago                                                                                   |
   | `MP_WEBHOOK_SECRET`   | Assinatura secreta do webhook de teste do Mercado Pago                                                                      |
   | `MP_NOTIFICATION_URL` | `<URL do Render>/api/webhooks/mercadopago` (a URL aparece no painel do serviço depois de criado; edite e salve se precisar) |

   `NODE_ENV=production` já vem no `render.yaml`. `PORT`, `ORDER_HOLD_MINUTES` e `PAYMENT_RECONCILIATION_INTERVAL_MS` ficam no padrão.

4. Acompanhe o primeiro deploy em **Events/Logs**:
   - O **Pre-Deploy** roda o migrator e aplica `0004` e `0005` (tabelas de pagamento; valor de enum, tabela de alertas e índice). Deve terminar sem erro.
   - Depois a API sobe e o health check `/api/health` passa a responder `200`.
   - Os logs não imprimem valores de variáveis. Se a API recusar subir, a mensagem diz qual variável falta (ex.: `WEB_ORIGIN` https ou `DATABASE_CA_CERT`).
5. Anote a URL pública do serviço (`https://otilc-api….onrender.com`). Teste no navegador: `<URL do Render>/api/health` deve mostrar `{"status":"ok","database":"ok"}`.

## 5. Criar o projeto na Vercel

1. Vercel → **Add New → Project** → importe o repositório `otilc-store`.
2. Configure:
   - **Root Directory**: `apps/web`.
   - **Framework Preset**: Next.js (detectado sozinho).
   - **Production Branch**: `main`, com deploy automático.
   - **Functions Region**: `iad1` (Washington, D.C.), em Settings → Functions.
   - **Previews desligados**: em Settings → Git, desative os deploys de branches/PRs (previews). Um preview apontaria para a API de produção e criaria pedidos reais.
3. **Environment Variables** (ambiente Production):
   - `API_URL` = URL pública do Render (passo 4), sem barra no final.
   - `NEXT_PUBLIC_API_URL` = a mesma URL do Render.
   - **Não** crie `NEXT_PUBLIC_ADMIN_MOCK`. Se existir ligada, o build de produção falha de propósito.
4. **Deploy**. Anote a URL da loja (`https://….vercel.app`).

## 6. Fechar o circuito: `WEB_ORIGIN` e webhook do Mercado Pago

1. Render → `otilc-api` → **Environment** → edite `WEB_ORIGIN` para a URL da Vercel, **com https e sem barra final** (ex. fictício: `https://loja.example.com`). Salve: o Render reinicia a API. O CORS e a verificação de `Origin` do admin só aceitam essa origem.
2. Confira `MP_NOTIFICATION_URL` = `<URL do Render>/api/webhooks/mercadopago`.
3. Painel do Mercado Pago → Suas integrações → sua aplicação → **Webhooks** (modo de testes): configure a URL `<URL do Render>/api/webhooks/mercadopago` e marque o evento de pagamentos. A assinatura secreta gerada ali é o `MP_WEBHOOK_SECRET` (se mudar, atualize no Render).
4. As credenciais ficam de **teste** até você decidir o lançamento; nessa hora é só trocar `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` (e o webhook) pelas de produção.

O timer de conciliação de Pix roda dentro da API (a cada 5 minutos por padrão), sem configuração extra.

### Criar o primeiro admin em produção

Depois do primeiro deploy (e do passo 6, para conseguir entrar no painel), crie o primeiro usuário do painel com o script que já existe (ADR 0002). Ele roda no **seu computador**, na raiz do repositório, e fala direto com o banco do Supabase:

1. Num terminal interativo, exporte as variáveis na sessão do shell, **sem criar arquivo `.env` e sem colar valores em nenhum lugar versionado**. O script carrega a configuração de produção inteira, então precisa de todas estas, com os mesmos valores do painel do Render: `NODE_ENV=production`, `DATABASE_URL` (session pooler), `DATABASE_CA_CERT`, `WEB_ORIGIN`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `MP_NOTIFICATION_URL`. Os valores de uma linha (`DATABASE_URL`, `WEB_ORIGIN`, as `MP_*`) você digita sem eco, por exemplo `read -rs DATABASE_URL && export DATABASE_URL`. O `DATABASE_CA_CERT` é PEM de várias linhas, e o `read` lê só uma: use o `.crt` baixado no passo 3, que preserva as quebras de linha, com `export DATABASE_CA_CERT="$(cat CAMINHO/DO/ARQUIVO.crt)"`. No histórico do shell fica só o caminho, não o certificado. Depois apague o arquivo `.crt` baixado.
2. Rode `npm run admin:create -w @otilc/api`. O script pergunta os dados pelo terminal e pede a senha sem eco; não aceita argumentos.
3. Feche o terminal (ou rode `unset` nas variáveis) e entre em `<URL da Vercel>/admin/login` para conferir.

## 7. Smoke test, falhas e rollback

### Rodar o smoke test

No seu computador (precisa de `curl`), na raiz do repositório:

```bash
scripts/smoke.sh <URL_DO_RENDER> <URL_DA_VERCEL>
```

O script só faz `GET`: não cria pedido, não faz login, não envia segredo. Ele confere `GET /api/health` (200), a lista pública de produtos, a home da loja, a página de um produto (o slug vem da lista) e a tela de login do admin. Sai com código diferente de zero na primeira falha, dizendo qual checagem quebrou. A Formiga roda o mesmo script depois de cada merge.

### Se falhar

| Sintoma                                 | O que olhar                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health` com 503 ou sem resposta   | Render → Logs. Banco inalcançável: confira `DATABASE_URL` (session pooler, senha) e `DATABASE_CA_CERT` (PEM completo).          |
| API não sobe, log pede `WEB_ORIGIN`/CA  | Variável ausente ou fora do formato (`WEB_ORIGIN` precisa de https).                                                            |
| Pre-Deploy falhou                       | Render → Events → log do Pre-Deploy. O deploy é cancelado e a versão anterior segue no ar. Não rode SQL à mão: chame a Bússola. |
| Lista de produtos vazia                 | O banco de produção pode não ter dados ainda; cadastre pelo painel admin e rode de novo.                                        |
| Home/produto da loja com erro           | Vercel → Deployment → Logs. Confira `API_URL` (URL do Render, sem barra final) e se a API está no ar.                           |
| Build da Vercel falhou por `ADMIN_MOCK` | Remova `NEXT_PUBLIC_ADMIN_MOCK` do ambiente Production e faça redeploy.                                                         |
| Login do admin falha no navegador       | `WEB_ORIGIN` deve ser exatamente a URL da loja (https, sem barra final).                                                        |

### Reverter um deploy

- **Render (API):** serviço `otilc-api` → **Events** (ou Deploys) → deploy anterior que estava saudável → **Rollback**. Atenção: o rollback não desfaz migrações já aplicadas no banco. As migrações do projeto são aditivas; mesmo assim, se o problema for de migração, chame a Bússola antes de qualquer outra ação. Para impedir novo deploy automático enquanto investiga, pause o deploy automático do serviço.
- **Vercel (loja):** projeto → **Deployments** → deploy anterior saudável → menu (⋯) → **Promote to Production** (ou **Instant Rollback**).
- Um problema vindo de código: o caminho limpo é um PR de correção ou de revert na `main`; o deploy automático publica o conserto.
