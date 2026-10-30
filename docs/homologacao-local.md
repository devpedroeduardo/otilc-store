# Homologação local: Pix com o Mercado Pago sandbox (API de Orders)

Roteiro manual para você provar, na sua máquina (WSL), que a loja gera um Pix no Mercado Pago pela **API de Orders** (`/v1/orders`), que o webhook de order volta por um túnel até a API local e que aprovação, expiração, cancelamento e conciliação funcionam. Decisões na [spec-017](../specs/017-homologacao-local.md) (roteiro) e na [spec-021](../specs/021-pix-api-de-orders.md) (troca da API de Pagamentos pela de Orders).

> **Nada aqui vai ao ar.** Sem Render, Vercel ou Supabase: a API roda com `NODE_ENV` de desenvolvimento (nunca `production`), contra o Postgres do `docker compose`. As seções 1 a 8 usam só credenciais de **teste**. A seção 9 (bloco final) usa credenciais de **produção** da sua própria conta do Mercado Pago, com um Pix real de cerca de R$ 1, e tem aviso próprio. Credenciais, segredo do webhook e token do túnel são seus: ficam em `apps/api/.env`, no painel do Mercado Pago e no `ngrok`, nunca no repositório.
>
> **Quando rodar:** depois do merge da spec-021 (a API de Orders só existe no código a partir dela).

## 1. Visão geral

```
navegador ──> loja (localhost:3000) ──> API (localhost:3333) ──> Postgres (docker, :5432)
                                          ^        │
                                          │        └──> api.mercadopago.com/v1/orders (cria / consulta / cancela)
   Mercado Pago ──> https://<seu-dominio>.ngrok-free.app ──> túnel ngrok ──┘   (webhook de order)
```

- Só a **API** passa pelo túnel (o webhook é de servidor para servidor). A loja fica em `http://localhost:3000`, então CORS e cookie do admin funcionam sem mudança.
- No sandbox da API de Orders, o Pix é aprovado sozinho quando o primeiro nome do pagador é **`APRO`** (a loja manda o primeiro nome do campo Nome do checkout). Por isso o sandbox cobre todos os casos: Pix gerado (c), Pix aprovado por webhook (d), expiração com cancelamento da order (e), webhook perdido e conciliação (f), pago depois da expiração (g), assinatura inválida (h), envio pelo admin (i) e cancelamento da order quando o admin marca pago (j) ou cancela (k).
- O **bloco final (seção 9)** fica só com o caso d, num Pix real de cerca de R$ 1 com credenciais de produção.
- Tempo estimado: 1 h para preparar (ngrok, conta e credenciais do Mercado Pago), cerca de 1 h para os casos do sandbox (e, f e g esperam alguns minutos) e 30 min para o bloco final.
- O que esta homologação descobre, porque nunca rodou contra o Mercado Pago real com a API de Orders: o formato real do `x-signature` com id de order, o corpo da notificação de order, a resposta do `POST /v1/orders/{id}/cancel` para order já paga e se o 500 no primeiro `POST` (achado 2 da spec-017) continua. Falha vira spec de correção própria, não conserto durante o roteiro: anote o sintoma e siga.
- A loja guarda o **id da order** (`ORD…`) em `payments.provider_payment_id`. Pagamentos antigos com id numérico (da API de Pagamentos, só no seu banco local) não são mais consultados: a conciliação os pula com um aviso no log.

## 2. Passo 0 — pré-requisitos

### 2.1 Relógio do WSL

O webhook só vale se o `ts` da assinatura estiver a até **5 minutos** do relógio da API. O relógio do WSL2 costuma atrasar depois que o Windows hiberna. Atrasado, todo webhook volta `401 Assinatura inválida`.

```bash
date -u
curl -sI https://www.google.com | grep -i '^date:'   # hora de referência, em GMT
```

Se as duas horas diferem em mais de 1 minuto, ressincronize:

```bash
sudo hwclock -s
```

Se não resolver, no PowerShell do Windows rode `wsl --shutdown` e abra o WSL de novo (a VM reacerta o relógio ao subir). Confira outra vez com `date -u`.

### 2.2 Túnel: ngrok (recomendado)

Fonte: documentação oficial do ngrok. Os links estão na seção 10.

1. Crie a conta em <https://dashboard.ngrok.com/signup> (plano gratuito).
2. Instale no WSL pelo método apt da página [Download ngrok for Linux](https://ngrok.com/download/linux):

   ```bash
   curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
     | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
     && echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \
     | sudo tee /etc/apt/sources.list.d/ngrok.list \
     && sudo apt update \
     && sudo apt install ngrok
   ```

   A página do ngrok usa o repositório `bookworm` (Debian 12) para todas as distribuições. Se o `apt` falhar no seu Ubuntu, a mesma página oferece `sudo snap install ngrok` e o binário `.tgz` avulso.

3. Cadastre o authtoken. Ele fica em <https://dashboard.ngrok.com/get-started/your-authtoken>; digite **no seu terminal** (nunca em arquivo do repositório):

   ```bash
   read -rsp 'Authtoken: ' NGROK_AUTHTOKEN && echo
   ngrok config add-authtoken "$NGROK_AUTHTOKEN"; unset NGROK_AUTHTOKEN
   ```

   Assim o token não aparece na tela nem fica no histórico do shell (o histórico guarda só o nome da variável).

4. **Domínio fixo.** O plano gratuito inclui **um** "dev domain" já atribuído à sua conta (algo como `<seu-dominio>.ngrok-free.app`; a documentação mostra também o sufixo `.ngrok-free.dev`). Ele não muda entre sessões, mas **o ngrok escolhe o nome e você não pode renomear nem reservar outro** ([Free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits), [Domains](https://ngrok.com/docs/gateway/domains)). Veja o seu em <https://dashboard.ngrok.com/domains> (não confirmei como essa tela se apresenta no plano gratuito; se não aparecer, o primeiro `ngrok http` imprime o domínio na linha `Forwarding`).
5. Suba o túnel apontando para a API (deixe este terminal aberto durante todo o roteiro):

   ```bash
   ngrok http 3333
   ```

   Sem `--url`, o plano gratuito usa o dev domain automaticamente. Para fixar explicitamente: `ngrok http 3333 --url https://<seu-dominio>.ngrok-free.app`.

6. Anote a URL `https://<seu-dominio>.ngrok-free.app` da linha `Forwarding`. A **interface de inspeção** está em <http://127.0.0.1:4040>: lista cada requisição que o Mercado Pago faz, com headers e corpo ([Web inspection](https://ngrok.com/docs/gateway/agent/web-inspection-interface)).

A página de aviso do plano gratuito do ngrok aparece só para tráfego de **navegador** e, segundo a documentação, não afeta quem chama a API por programa, como o Mercado Pago ([Free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)). Se o webhook não chegar à API mesmo com o túnel de pé, comece por aqui e veja a requisição em `:4040`.

### 2.3 Alternativa: cloudflared (quick tunnel)

Sem conta, mas a URL `https://<algo>.trycloudflare.com` **muda a cada subida**. Toda vez que mudar, você troca a URL no painel do Mercado Pago (3.3); a API não guarda a URL. Instalação pelo repositório `apt` da Cloudflare ([Downloads](https://developers.cloudflare.com/tunnel/downloads/)); depois:

```bash
cloudflared tunnel --url http://localhost:3333
```

A URL aparece na saída do comando ([Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)). Para o resto do roteiro, onde estiver `<seu-dominio>.ngrok-free.app`, use a URL do cloudflared.

### 2.4 Projeto rodando como no README

Na raiz do repositório:

```bash
npm install
docker compose up -d db
cp apps/api/.env.example apps/api/.env          # só se ainda não existir
cp apps/web/.env.example apps/web/.env.local    # só se ainda não existir
npm run db:migrate
npm run db:seed
```

Os `.env` ficam fora do git (`.gitignore`). Você preenche `apps/api/.env` na seção 4, antes de subir a API com `npm run dev`.

## 3. Mercado Pago sandbox

O passo a passo exato muda no painel do Mercado Pago; confira cada tela na documentação, linkada na seção 10.

### 3.1 Aplicação e credenciais de teste

1. Em <https://www.mercadopago.com.br/developers/panel/app> crie (ou reaproveite) uma aplicação de **Checkout Transparente / API de Orders** (a loja chama `POST /v1/orders`).
2. Em **Credenciais**, selecione o ambiente de **Teste**. Copie o **Access Token de teste**. O prefixo do token (`TEST-` ou `APP_USR-`) não importa: a API aceita qualquer token com 8 a 500 caracteres, então cole o que o painel mostrar.

### 3.2 E-mail e nome do pagador no sandbox

A API de Orders, no ambiente de teste, aceita **só** o e-mail `test@testuser.com` como pagador ([Realizar uma compra teste com Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix)); outro e-mail volta `400` (`invalid_email_for_sandbox`). O e-mail de usuário de teste no formato `test_user_<id>@testuser.com` foi recusado na spec-017 com `403` (`cause 4390`, achado 1): registre no caso c se isso ainda acontece.

O status final do Pix de teste depende do **primeiro nome** do pagador, que a loja tira do campo **Nome** do checkout (a primeira palavra):

| Nome no checkout       | O que o sandbox faz com o Pix                      | Casos         |
| ---------------------- | -------------------------------------------------- | ------------- |
| `Ana Teste` (qualquer) | fica pendente (`action_required/waiting_transfer`) | c, e, h, j, k |
| `APRO Teste`           | aprova sozinho logo depois de criar (`processed`)  | d, f, g, i    |

Contas de teste (vendedor/comprador) não são necessárias para estes casos.

### 3.3 Webhook no painel: evento Order

Em **Suas integrações → sua aplicação → Webhooks → Configurar notificações** ([Notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications)):

1. Na **URL modo teste**, coloque `https://<seu-dominio>.ngrok-free.app/api/webhooks/mercadopago`.
2. Marque o evento **Order (Mercado Pago)**. A loja ignora notificações de **Pagamentos** (`type=payment`, responde `200` sem fazer nada); deixe esse evento ligado só até a virada em produção (seção 9.7).
3. Na **URL modo produção**, coloque a **mesma** URL com o mesmo evento (a virada em produção usa a URL do Render; seção 9.7).
4. **Salvar**. Revele a **assinatura secreta** em Webhooks → Configurar notificação: ela vai para `MP_WEBHOOK_SECRET` (seção 4). Confira se é a mesma que você já usava; se o painel gerar outra para o evento Order, use a nova.
5. Se o painel tiver o botão para **simular** o envio de uma notificação, use-o no caso h-2.

A API de Orders não tem `notification_url` na order: a URL do painel é a única. Por isso `MP_NOTIFICATION_URL` saiu da API (se ainda estiver no seu `.env`, é ignorada; pode apagar).

## 4. Onde colocar cada valor

Nenhum valor real vai para arquivo versionado. `apps/api/.env` e `apps/web/.env.local` estão no `.gitignore`.

| Variável                             | Arquivo / lugar        | De onde vem                                       | Exemplo (fictício)                                              |
| ------------------------------------ | ---------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`                       | `apps/api/.env`        | já vem do `.env.example`                          | `postgres://otilc:otilc@localhost:5432/otilc`                   |
| `WEB_ORIGIN`                         | `apps/api/.env`        | padrão do `.env.example`; não mude                | `http://localhost:3000`                                         |
| `MP_ACCESS_TOKEN`                    | `apps/api/.env`        | Credenciais de teste (3.1)                        | `TEST-xxxx`                                                     |
| `MP_WEBHOOK_SECRET`                  | `apps/api/.env`        | assinatura secreta do Webhooks (3.3)              | `segredo-ficticio`                                              |
| `ORDER_HOLD_MINUTES`                 | `apps/api/.env`        | só para o teste (mínimo da API é 5)               | `5`                                                             |
| `PAYMENT_RECONCILIATION_INTERVAL_MS` | `apps/api/.env`        | só para o teste (mínimo da API é 30000)           | `30000`                                                         |
| `API_URL`, `NEXT_PUBLIC_API_URL`     | `apps/web/.env.local`  | padrão do `.env.example`: `http://localhost:3333` | não mude                                                        |
| URL do webhook (teste e produção)    | painel do Mercado Pago | túnel + `/api/webhooks/mercadopago` (3.3)         | `https://<seu-dominio>.ngrok-free.app/api/webhooks/mercadopago` |

- Não defina `NODE_ENV=production`: produção exige `DATABASE_CA_CERT` e `WEB_ORIGIN` https, que não existem aqui.
- **Depois de mudar o `apps/api/.env`, pare a API (Ctrl+C) e rode `npm run dev` de novo**: ela só lê o `.env` ao iniciar. Se mudar de URL de túnel, mude só no painel.
- No fim do roteiro, restaure `ORDER_HOLD_MINUTES` (padrão 30) e `PAYMENT_RECONCILIATION_INTERVAL_MS` (padrão 300000), ou apague as duas linhas.

Suba tudo: túnel (2.2) em um terminal, e em outro `npm run dev` (API em `:3333`, loja em `:3000`).

## 5. Casos de teste

Marque OK ou FALHA em cada um e preencha a tabela da seção 8. Para as consultas `psql`, veja a seção 6. “Log da API” é a saída do terminal do `npm run dev`; “ngrok” é <http://127.0.0.1:4040>. Em todos os pedidos do sandbox use o e-mail `test@testuser.com` e o nome indicado em cada caso (3.2).

### a) Smoke test

- **Ação:** `scripts/smoke.sh http://localhost:3333 http://localhost:3000`
- **Esperado:** cinco linhas `OK` (health, lista de produtos, home, página de produto, login do admin) e `Smoke test concluído: tudo certo.` O script só faz `GET`.
- **Resultado:** [ ] OK [ ] FALHA

### b) Primeiro admin e login

- **Ação:** `npm run admin:create -w @otilc/api`. Responda e-mail (ex.: `admin@example.com`), nome, papel `OWNER` e uma senha de teste com 12 ou mais caracteres, digitada sem eco. Depois abra <http://localhost:3000/admin/login> e entre. O login admin aceita 5 tentativas por minuto.
- **Esperado:** o script confirma a criação; o login leva ao painel, e a lista de pedidos abre em `/admin/orders`.
- **Resultado:** [ ] OK [ ] FALHA

### c) Pedido e Pix gerado

- **Ação:** em <http://localhost:3000> escolha uma peça, o tamanho, “Adicionar ao carrinho”, abra o carrinho e preencha Nome **`Ana Teste`**, E-mail **`test@testuser.com`** e WhatsApp com DDD. Clique em “Finalizar pedido”.
- **Esperado (tela):** redireciona para `/pedido/<id>` com “Aguardando pagamento”, o QR code e o Pix copia e cola, e uma contagem de 5 minutos.
- **Esperado (banco):** `orders.status = PENDING_PAYMENT`; uma linha em `payments` com `status = PENDING`, `provider_payment_id` começando com `ORD` e `amount_cents` igual ao total; `variants.reserved` da peça subiu.
- **Achado 2 (500 no primeiro `POST`):** olhe o log da API logo depois de finalizar. Se aparecer `Mercado Pago POST /v1/orders respondeu 500 (...)` seguido de um Pix gerado na segunda tentativa da página, o achado continua: anote a linha inteira (ela não traz token, e-mail nem nome). Sem essa linha, o primeiro `POST` passou.
- **Achado 1 (e-mail de usuário de teste):** crie mais um pedido com o e-mail `test_user_<id>@testuser.com` de uma conta de teste. Anote o que a linha `Mercado Pago POST /v1/orders respondeu ...` diz (esperado: recusa, `403` com `cause 4390` na spec-017, ou `400 invalid_email_for_sandbox` na API de Orders). Esse pedido mostra “Pix indisponível”, o que é o esperado aqui.
- **Se aparecer “Pix indisponível” no pedido com `test@testuser.com`:** a API respondeu 503. Olhe o log da API: `Mercado Pago <método> <rota> respondeu NNN (código): mensagem` traz o status e o código de erro do Mercado Pago; `Mercado Pago indisponível (rede)` ou `(tempo esgotado)` é falha de conexão; `Resposta inesperada ao criar o Pix.` é resposta fora do formato esperado (anote). **Sem nenhuma linha nova no log**, falta `MP_ACCESS_TOKEN` ou `MP_WEBHOOK_SECRET` no `apps/api/.env` (ou a API não foi reiniciada depois de editar). Nunca cole o token em lugar nenhum.
- **Resultado:** [ ] OK [ ] FALHA — 1º POST com 500: [ ] sim [ ] não — `test_user_<id>`: ________

### d) Pix aprovado (APRO) → webhook `order.processed` → pedido `PAID`

- **Ação:** com o túnel de pé, crie um pedido com Nome **`APRO Teste`** e e-mail `test@testuser.com`. Deixe a página do pedido aberta.
- **Esperado (ngrok):** em <http://127.0.0.1:4040> aparece `POST /api/webhooks/mercadopago?data.id=ORD…&type=order` com resposta `200`. Anote os headers `x-signature` e `x-request-id` e o `action` do corpo (esperado `order.processed`), sem copiar o segredo.
- **Esperado (tela):** “Pagamento confirmado”. A página consulta a API a cada 5 s e a API consulta o Mercado Pago no máximo a cada 20 s, então a tela pode atualizar **sem** o webhook. Quem prova o webhook é a consulta abaixo.
- **Esperado (banco):** `orders.status = PAID`; `payments.status = APPROVED` com `approved_at` preenchido; `variants.stock` caiu 1 e `reserved` voltou; **`payment_notifications` tem ao menos uma linha** para o `provider_payment_id` (`ORD…`).
- **Outras notificações:** se o evento Pagamentos ainda estiver ligado, chegam também `?data.id=<número>&type=payment`, que a API responde com `200` sem fazer nada. Notificações de order com outro `action` (ex.: `order.action_required`) também são `200`. Anote o que chegou.
- **Resultado:** [ ] OK [ ] FALHA

### e) Pedido não pago expira e a order é cancelada

- **Ação:** crie um pedido com Nome **`Ana Teste`** (não `APRO`) e **não pague**. Deixe passar o prazo (`ORDER_HOLD_MINUTES=5`) mais o intervalo do job (a cada 60 s): cerca de 6 minutos.
- **Esperado (log da API):** `N pedido(s) expirado(s); estoque liberado.` Com só este pedido vencido, `N` é 1; se outro pedido pendente (por exemplo, o do caso c) vencer na mesma rodada do job, `N` conta os dois.
- **Esperado (tela):** a página do pedido passa a “Pedido expirado” aos 5 minutos, pela contagem do navegador, **antes** de o job rodar. A prova da expiração é o log e o banco, não a tela.
- **Esperado (banco):** `orders.status = EXPIRED`; `variants.reserved` voltou ao valor de antes; `payments.status = CANCELLED`. A API só registra no log quando o cancelamento **falha** (`Cancelamento do Pix ORD… falhou: ...`, junto com a linha `Mercado Pago POST /v1/orders/{id}/cancel respondeu ...`); ausência dessas linhas e `CANCELLED` no banco são o sinal de que o `POST /v1/orders/{id}/cancel` foi aceito.
- **Esperado (Mercado Pago):** a order aparece como `canceled` se você consultar `GET /v1/orders/<id>` com o seu token (ou no painel, se houver tela de orders de teste).
- **Resultado:** [ ] OK [ ] FALHA

### f) Webhook perdido → conciliação

- **Ação:** **derrube o túnel** (Ctrl+C no ngrok) antes de criar o pedido. Crie um pedido com Nome **`APRO Teste`**. Quando o QR aparecer, **feche a aba** (com a aba aberta, a página consulta a API a cada 5 s e a verificação sob demanda confirma o pagamento antes da conciliação; isso também vale como OK, mas não prova a conciliação). Espere cerca de 3 minutos. Suba o túnel de novo só depois do resultado.
- **Por que 3 minutos:** a conciliação roda a cada 30 s (`PAYMENT_RECONCILIATION_INTERVAL_MS=30000`) e só olha Pix com mais de 2 min, então confirma entre 2 min e 2 min 30 s depois de criar o pedido, antes de ele vencer aos 5 min.
- **Esperado (banco, é o critério do OK):** `orders.status = PAID` e `payments.status = APPROVED`, sem linha nova em `payment_notifications` para esse pagamento.
- **Log da API:** a linha `Conciliação: N pagamento(s) conferido(s), 0 com falha.` aparece a cada rodada que confere alguma cobrança e **não serve de prova**.
- **Obs.:** o Mercado Pago reenvia webhooks não confirmados; se um reenvio chegar depois que o túnel voltar, ele não muda nada.
- **Resultado:** [ ] OK (conciliação) [ ] OK (sob demanda, aba aberta) [ ] FALHA

### g) Pix aprovado com a loja sem saber → expiração → `EXPIRED` + `PAID_AFTER_EXPIRY`

Prova o caminho “order não cancelável”: a expiração tenta cancelar uma order que o Mercado Pago já aprovou, recebe a recusa, consulta a order e aplica o estado real.

- **Preparo:** ponha `PAYMENT_RECONCILIATION_INTERVAL_MS=3600000` (1 hora, para a conciliação não rodar durante o caso) no `apps/api/.env` e reinicie a API. Derrube o túnel.
- **Ação:** crie um pedido com Nome **`APRO Teste`**. Quando o QR aparecer, **feche a aba** (sem a página aberta não há verificação sob demanda). Espere cerca de 6 minutos (prazo de 5 min mais o job de 60 s).
- **Esperado (log da API), nesta ordem:** `1 pedido(s) expirado(s); estoque liberado.`; uma linha `Mercado Pago POST /v1/orders/{id}/cancel respondeu 4xx (código)` (anote o status e o código: é a recusa de cancelar uma order já paga); e o aviso `Pagamento ORD… do pedido <id>: alerta PAID_AFTER_EXPIRY.`
- **Esperado (banco):** `orders.status = EXPIRED` (o pedido **não** vira `PAID`); `variants.reserved` voltou; `payments.status = APPROVED`; uma linha em `payment_alerts` com `alert = PAID_AFTER_EXPIRY`.
- **Depois:** volte `PAYMENT_RECONCILIATION_INTERVAL_MS=30000` e reinicie a API; suba o túnel. O estorno é manual, no painel do Mercado Pago (no sandbox não há dinheiro de verdade).
- **Se o log mostrar `Cancelamento do Pix ORD… falhou` em vez do alerta:** o Mercado Pago respondeu de um jeito que a API não reconhece como “não cancelável” (ex.: `401`, `404`, `5xx`). Anote a linha `Mercado Pago POST ... respondeu ...`; a conciliação ainda confirma o pagamento depois (com o mesmo alerta).
- **Resultado:** [ ] OK [ ] FALHA

### h) Assinatura inválida → 401

h-1, sem o Mercado Pago. Direto na API local:

```bash
curl -i -X POST 'http://localhost:3333/api/webhooks/mercadopago?data.id=ORD01JP84C939T20S0P1DN382FQ6K&type=order' \
  -H 'content-type: application/json' \
  -H 'x-request-id: teste-assinatura-invalida' \
  -H "x-signature: ts=$(date +%s),v1=0000000000000000000000000000000000000000000000000000000000000000" \
  -d '{"type":"order","action":"order.processed","data":{"id":"ORD01JP84C939T20S0P1DN382FQ6K"}}'
```

- **Esperado:** `HTTP/1.1 401` com a mensagem `Assinatura inválida.` O `ts` é o horário atual (dentro da janela de ±5 min) e o `v1` é um HMAC errado, então o 401 vem da conferência da assinatura, não de timestamp vencido. Nada gravado em `payment_notifications`.

h-2, só se o painel tiver o botão de simular notificação (3.3): dispare uma notificação de **Order** para a URL do túnel.

- **Esperado:** `200` em `:4040` (a order simulada não é de nenhuma cobrança da loja, então a API só registra `Notificação de pagamento desconhecido ORD…; ignorada.` no log e não muda nada). Isso prova que a assinatura **real** do Mercado Pago passa na validação com id de order. Um `401` aqui indica relógio errado (2.1), segredo diferente do painel ou formato de assinatura diferente do esperado: anote os headers (sem o segredo). Um `400` indica `data.id` fora do formato `ORD` + letras maiúsculas e dígitos: anote o `data.id` que chegou.
- **Resultado:** h-1 [ ] OK [ ] FALHA — h-2 [ ] OK [ ] FALHA [ ] não existe

### i) Admin marca o pedido como enviado

- **Ação:** em `/admin/orders`, abra o pedido pago do caso d (ou f) e clique em “Marcar enviado”.
- **Esperado:** `orders.status = SHIPPED`; o botão some.
- **Resultado:** [ ] OK [ ] FALHA

### j) Admin marca pago um pedido com Pix gerado e a order é cancelada

- **Ação:** crie um pedido novo com Nome **`Ana Teste`** e espere o QR aparecer. Antes de ele vencer, abra o pedido em `/admin/orders` e clique em “Marcar pago”.
- **Esperado (banco):** `payments.status = CANCELLED` e `orders.status = PAID`; `variants.reserved` voltou e `stock` caiu 1. Sem linha `Cancelamento do Pix ORD… falhou` no log.
- **Esperado (Mercado Pago):** a order aparece como `canceled` (`GET /v1/orders/<id>` com o seu token, ou no painel).
- **Se o painel mostrar “Não foi possível cancelar o Pix no Mercado Pago. Tente de novo.”:** a API respondeu 502 e nada mudou no banco; o log traz `Cancelamento do Pix ORD… falhou (pedido <id>): ...` e a linha `Mercado Pago POST /v1/orders/{id}/cancel respondeu ...`. Anote as duas (sem o token).
- **Resultado:** [ ] OK [ ] FALHA

### k) Admin cancela um pedido pendente com Pix gerado e a order é cancelada

- **Ação:** como no caso j, mas clique em “Cancelar” em vez de “Marcar pago”.
- **Esperado (banco):** `payments.status = CANCELLED` e `orders.status = CANCELED`; `variants.reserved` voltou ao valor de antes (reserva devolvida) e `stock` não mudou.
- **Esperado (Mercado Pago):** igual ao caso j.
- **Resultado:** [ ] OK [ ] FALHA

## 6. Consultas `psql` (só leitura)

Contra o Postgres local do `docker compose` (usuário `otilc`, banco `otilc`). Use somente `SELECT`.

```bash
# atalho: rode com  docker compose exec db psql -U otilc -d otilc -c "<consulta>"

# Pedidos mais recentes
SELECT number, status, total_cents, expires_at, created_at
FROM orders ORDER BY created_at DESC LIMIT 5;

# Cobranças Pix (uma linha por tentativa)
SELECT o.number AS pedido, p.status, p.provider_payment_id, p.amount_cents,
       p.approved_at, p.last_checked_at, p.alert, p.created_at
FROM payments p JOIN orders o ON o.id = p.order_id
ORDER BY p.created_at DESC LIMIT 5;

# Webhooks aceitos (uma linha por x-request-id)
SELECT request_id, provider_payment_id, received_at
FROM payment_notifications ORDER BY received_at DESC LIMIT 10;

# Alertas de pagamento
SELECT a.alert, a.created_at, p.provider_payment_id
FROM payment_alerts a JOIN payments p ON p.id = a.payment_id
ORDER BY a.created_at DESC LIMIT 10;

# Estoque reservado
SELECT sku, size, stock, reserved FROM variants WHERE reserved > 0 OR stock = 0 LIMIT 20;
```

Cada comando de verdade é uma linha: `docker compose exec db psql -U otilc -d otilc -c "SELECT ..."` (em uma linha só, com aspas duplas por fora).

## 7. Problemas comuns

| Sintoma                                                                         | Causa provável e o que fazer                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook responde `401 Assinatura inválida`                                      | Relógio do WSL fora (2.1); `MP_WEBHOOK_SECRET` diferente da assinatura do painel (ela muda se você a redefinir; reinicie a API depois de atualizar o `.env`); notificação de um app/conta diferente da configurada.                                                                                                   |
| Loja mostra “Pix indisponível” (503)                                            | Falta `MP_ACCESS_TOKEN` ou `MP_WEBHOOK_SECRET` no `apps/api/.env` (e a API não foi reiniciada), ou o Mercado Pago recusou a criação: veja a linha `Mercado Pago POST /v1/orders respondeu NNN (código)` no log da API. No sandbox, `400 invalid_email_for_sandbox` é o e-mail diferente de `test@testuser.com` (3.2). |
| A API não sobe com “Configuração inválida”                                      | A mensagem lista só os nomes das variáveis. `ORDER_HOLD_MINUTES` ≥ 5; `PAYMENT_RECONCILIATION_INTERVAL_MS` entre 30000 e 3600000.                                                                                                                                                                                     |
| Webhook não chega à API                                                         | Túnel caído ou outra URL (o cloudflared muda a cada subida; atualize o painel); a URL do painel não termina em `/api/webhooks/mercadopago`; o evento **Order (Mercado Pago)** não está marcado (3.3); veja a requisição em `http://127.0.0.1:4040`.                                                                   |
| `403 Origem não permitida` no login do admin                                    | Abriu a loja por outro endereço que não `http://localhost:3000` (a API compara a origem exata em `WEB_ORIGIN`). Use `localhost`, não `127.0.0.1` nem o domínio do túnel.                                                                                                                                              |
| Login do admin bloqueado (`429`)                                                | O login aceita 5 tentativas por minuto por IP. Espere 1 minuto.                                                                                                                                                                                                                                                       |
| `429` ao criar pedido                                                           | A criação de pedido aceita 10 por minuto por IP. Espere 1 minuto.                                                                                                                                                                                                                                                     |
| Pedido expirado não aceita Pix (`409`, “Este pedido não pode mais ser pago: …”) | Um pedido expirado não é reaproveitado: crie outro pedido. O estoque já foi devolvido.                                                                                                                                                                                                                                |
| Peça sem estoque ao criar outro pedido                                          | Cada peça tem uma unidade; ela fica reservada enquanto o pedido está `PENDING_PAYMENT`. Espere expirar ou use outra peça. `npm run db:seed` recarrega o catálogo, mas faz `TRUNCATE ... CASCADE`: **apaga pedidos, pagamentos, alertas e o produto de teste da seção 9.1**. Anote os resultados antes de rodar.       |

## 8. Resultado para enviar à Bússola

| Caso   | O que prova                                           | OK / FALHA / não executável | Observações (sintoma, log, código HTTP; nunca segredo) |
| ------ | ----------------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| a      | smoke test local                                      |                             |                                                        |
| b      | primeiro admin e login                                |                             |                                                        |
| c      | pedido e Pix gerado (order `ORD…`)                    |                             | 1º POST com 500? `test_user_<id>`: qual resposta?      |
| d      | APRO → webhook `order.processed` → PAID               |                             | `action` e headers que chegaram                        |
| e      | expiração e order cancelada                           |                             |                                                        |
| f      | webhook perdido → conciliação                         |                             | conciliação ou sob demanda                             |
| g      | order já paga não cancela → GET → `PAID_AFTER_EXPIRY` |                             | status e código da recusa do `/cancel`                 |
| h-1    | assinatura inválida → 401                             |                             |                                                        |
| h-2    | simulação do painel → 200                             |                             |                                                        |
| i      | admin marca enviado                                   |                             |                                                        |
| j      | admin marca pago e a order é cancelada                |                             |                                                        |
| k      | admin cancela e a order é cancelada                   |                             |                                                        |
| d-prod | (bloco final) Pix real → webhook → PAID               |                             |                                                        |

Também envie: formato real do `x-signature`/`x-request-id` e do corpo da notificação de order que chegou (sem o segredo), se a assinatura secreta do evento Order é a mesma de antes e qualquer comportamento diferente do esperado.

## 9. Bloco final: Pix real de cerca de R$ 1 (credenciais de produção)

> **ATENÇÃO. Faça este bloco só depois de fechar as seções 1 a 8.**
>
> - Aqui entram as credenciais de **PRODUÇÃO** do Mercado Pago, da conta do **seu próprio** Mercado Pago (**não** a da conta do cliente nem de ninguém mais). Pagamento real: o dinheiro (cerca de R$ 1) sai da sua conta bancária e cai na sua conta do Mercado Pago, com a tarifa do Mercado Pago.
> - Elas ficam **somente** no `apps/api/.env` local. Nada de commit, chat, print com o token à mostra, Render, Vercel ou qualquer deploy.
> - A API continua em `localhost`, com `NODE_ENV` de desenvolvimento, atrás do túnel. **Enquanto o túnel estiver de pé, toda a API local fica acessível na internet** (inclusive o login do admin): use uma senha de teste forte, suba o túnel só quando for usar e derrube-o ao terminar o bloco.
> - Ao fim, volte às credenciais de teste (9.5) e revogue ou troque as de produção (9.6).

Este bloco repete só o caso **d** com dinheiro de verdade: os outros casos que precisam de Pix aprovado (f e g) já rodaram no sandbox com `APRO`.

### 9.1 Pedido de cerca de R$ 1, sem mudar código

O preço sempre vem do banco (`priceCents`) e o `ORDER_HOLD_MINUTES` mínimo é 5; nenhum valor mínimo de pedido é imposto pela loja. Então crie um **produto de teste** de R$ 1,00 pelo painel do admin local (a sessão do caso b é `OWNER`):

1. Confira o slug de uma categoria: `docker compose exec db psql -U otilc -d otilc -c "SELECT slug FROM categories"` (o catálogo do Drop 00 traz `tenis`, `camisetas`, `calcas`, `casacos`, `bones`; use o que o `SELECT` mostrar).
2. Em <http://localhost:3000/admin/products/new> preencha: Nome `Produto de teste Pix`, Slug `produto-de-teste-pix`, Categoria (slug) `camisetas` (ou o do passo 1), Preço em centavos **`100`**, Status **`ACTIVE`**. Os outros campos podem ficar vazios; “Condição”, se pedir, `10`. Clique em “Salvar produto” **uma vez** e confira o aviso “Produto salvo.”. A tela continua em `/admin/products/new`; salvar de novo recusa o slug repetido.
3. “Nova variação” só existe na tela de edição do produto: vá em <http://localhost:3000/admin>, ache “Produto de teste Pix” na lista e clique em **Abrir**. Em “Nova variação” preencha (`color` pode ficar vazio) e clique em “Criar variação”: crie `sku` `TESTE-PIX-1`, `size` `U`, `stock` `3` (sobra para refazer o caso d; cada pedido reserva 1 unidade até pagar ou expirar).
4. Na loja, o produto aparece em <http://localhost:3000/produto/produto-de-teste-pix>. A loja guarda o catálogo em cache por 30 s: se o produto ou o tamanho `U` não aparecer, espere 30 s e recarregue. O total do pedido deve ser **R$ 1,00**. O menor valor que o Pix do Mercado Pago aceita **não foi confirmado**: se a criação falhar com R$ 1,00 (veja o log da API, `Mercado Pago POST /v1/orders respondeu NNN (código)`; se vier `400`, o código diz se é o valor mínimo ou o e-mail do pagador; anote), suba o preço para `500` (R$ 5,00) e anote.
5. No fim, para tirar o produto da vitrine: altere o status para `DRAFT` (a API não tem exclusão de produto).

### 9.2 Credenciais de produção e webhook de produção

1. No painel do Mercado Pago ([Suas integrações](https://www.mercadopago.com.br/developers/panel/app)), na **mesma** aplicação, abra **Credenciais** e selecione o ambiente de **Produção** (ativar produção pode pedir dados da conta; siga o painel). Copie o **Access Token de produção**. Não cole em nenhum lugar fora do `apps/api/.env`.
2. Em **Webhooks → Configurar notificações**, confira a **URL modo produção** `https://<seu-dominio>.ngrok-free.app/api/webhooks/mercadopago` com o evento **Order (Mercado Pago)** (3.3) e salve. Revele a **assinatura secreta de produção** (ela é **diferente** da de teste).
3. Anote os valores antigos (de teste) em um bloco de notas **fora do repositório**, só para o passo 9.5.

### 9.3 Trocar o `.env` e subir

No `apps/api/.env` substitua `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` pelos de **produção** (os placeholders de exemplo da seção 4 mostram o formato). `ORDER_HOLD_MINUTES=5` e `PAYMENT_RECONCILIATION_INTERVAL_MS=30000` continuam como estão. Pare a API (Ctrl+C), rode `npm run dev` e suba o túnel (`ngrok http 3333`). Use sempre o produto `produto-de-teste-pix`, com um e-mail **comum** (não `test@testuser.com`) e **diferente** do da sua conta do Mercado Pago (ele é enviado ao Mercado Pago como pagador). O nome pode ser qualquer um: `APRO` só tem efeito no sandbox.

### 9.4 Caso d em produção

**d-prod) Pix real pago → webhook → pedido `PAID`**

- **Ação:** crie o pedido (caso c, com o produto de R$ 1,00). Com a página do pedido aberta, pague o Pix copia e cola pelo app do seu banco.
- **Esperado:** o mesmo do caso d do sandbox: em `:4040`, `POST /api/webhooks/mercadopago?data.id=ORD…&type=order` com `200`; no banco, `orders.status = PAID`, `payments.status = APPROVED`, estoque baixado uma vez e **ao menos uma linha em `payment_notifications`** para a order.
- **Resultado:** [ ] OK [ ] FALHA

### 9.5 Voltar às credenciais de teste

1. Pare a API e derrube o túnel.
2. No `apps/api/.env`, volte `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` para os valores de **teste** (ou apague as duas linhas, e o Pix fica desligado).
3. No painel do Mercado Pago, esvazie a **URL modo produção** do webhook (ou aponte para outra) para o Mercado Pago parar de chamar o túnel.
4. Apague as linhas de `ORDER_HOLD_MINUTES` e `PAYMENT_RECONCILIATION_INTERVAL_MS` do `.env` (ou restaure 30 e 300000) e coloque o produto de teste em `DRAFT` (9.1, passo 5).

### 9.6 Último passo: revogar ou trocar as credenciais de produção

O token de produção passou pelo seu terminal e pelo `.env` local. Não o deixe valendo:

1. Em **Suas integrações → sua aplicação → Credenciais (Produção)**, escolha o par de credenciais, o menu de três pontos e **Renovar → Renovar agora**. Segundo a documentação, as duas credenciais do par são renovadas e as antigas **continuam valendo por até 12 horas**, então a troca não é imediata ([Renovação de credenciais](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/security/oauth/renewal), [Como renovo as credenciais?](https://www.mercadopago.com.br/ajuda/como-renovo-credenciais_20215)). Não li essas páginas por inteiro: confirme o menu no painel.
2. Se você não vai usar a aplicação em produção, não guarde o token novo em lugar nenhum.
3. Se o token chegou a ser exposto (colado em chat, commit, print), renove na hora e verifique em **Seus pagamentos** se há movimentação que você não reconhece. Boas práticas oficiais: [Mantenha suas credenciais seguras](https://www.mercadopago.com.br/developers/pt/docs/checkout-api/best-practices/credentials-best-practices/secure-credentials).
4. Confira que `git status` não mostra o `.env` (ele está no `.gitignore`).

### 9.7 Virada em produção (depois do merge da spec-021)

Ordem combinada na spec-021 (Q13). Os passos são seus; a Formiga faz o smoke test depois do deploy.

1. **Painel do Mercado Pago:** na aplicação de produção, ative o evento **Order (Mercado Pago)** nas abas **teste** e **produção**, com a URL do Render (`<URL do Render>/api/webhooks/mercadopago`). Deixe o evento Pagamentos ligado por enquanto.
2. **Homologação local:** rode as seções 5 e 9 deste roteiro (sandbox e Pix real).
3. **Merge e deploy.** Produção não tem pagamentos antigos (a tabela `payments` vai ao ar junto), então não há cobrança pendente a esperar. A variável `MP_NOTIFICATION_URL` no Render deixa de ser lida; apague quando quiser.
4. **Pix real em produção:** um Pix de cerca de R$ 1 no site no ar, como o caso d-prod.
5. **Desligue o evento Pagamentos** no painel (teste e produção). Até lá, as notificações `type=payment` são respondidas com `200` e ignoradas.

## 10. Links oficiais

ngrok:

- [Download ngrok for Linux](https://ngrok.com/download/linux) (instalação por apt, `ngrok config add-authtoken`)
- [Instalar o ngrok no Linux](https://ngrok.com/docs/gateway/device-gateway/linux)
- [Free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits) (dev domain, página de aviso, limites)
- [Domains](https://ngrok.com/docs/gateway/domains)
- [Web inspection interface](https://ngrok.com/docs/gateway/agent/web-inspection-interface)

Cloudflare:

- [Downloads do cloudflared](https://developers.cloudflare.com/tunnel/downloads/)
- [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)

Mercado Pago (API de Orders):

- [Integrar Pix (API de Orders)](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/websites/pix)
- [Realizar uma compra teste com Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix) (`test@testuser.com` e `APRO`)
- [Status da order](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/order-status)
- [Notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications) (evento Order, assinatura `x-signature`)
- [Migrar da API de Pagamentos para a de Orders](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/resources/migrate-payments-to-orders)
- [Possíveis erros da API](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/integration-errors/api)

Contrato da própria API: [docs/api/pagamentos.md](api/pagamentos.md).
