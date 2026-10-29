# Homologação local: Pix com o Mercado Pago sandbox

Roteiro manual para você provar, na sua máquina (WSL), que a loja gera um Pix no Mercado Pago (teste, e um Pix real mínimo no bloco final), que o webhook volta por um túnel até a API local e que expiração, cancelamento e conciliação funcionam. Decisões na [spec-017](../specs/017-homologacao-local.md).

> **Nada aqui vai ao ar.** Sem Render, Vercel ou Supabase: a API roda com `NODE_ENV` de desenvolvimento (nunca `production`), contra o Postgres do `docker compose`. As seções 1 a 8 usam só credenciais de **teste**. A seção 9 (bloco final) usa credenciais de **produção** da sua própria conta do Mercado Pago, com um Pix real de cerca de R$ 1, e tem aviso próprio. Credenciais, segredo do webhook e token do túnel são seus: ficam em `apps/api/.env`, no painel do Mercado Pago e no `ngrok`, nunca no repositório.

## 1. Visão geral

```
navegador ──> loja (localhost:3000) ──> API (localhost:3333) ──> Postgres (docker, :5432)
                                          ^        │
                                          │        └──> api.mercadopago.com (cria / consulta / cancela o Pix)
   Mercado Pago ──> https://<seu-dominio>.ngrok-free.app ──> túnel ngrok ──┘   (webhook)
```

- Só a **API** passa pelo túnel (o webhook é de servidor para servidor). A loja fica em `http://localhost:3000`, então CORS e cookie do admin funcionam sem mudança.
- O que o sandbox prova (seções 2 a 8): Pix gerado (caso c), pedido que expira e Pix cancelado no Mercado Pago (e), assinatura inválida (h) e envio pelo admin (i).
- O que só um Pix **pago** prova fica no **bloco final (seção 9)**, com um Pix real de cerca de R$ 1: confirmação por webhook (d), webhook perdido e conciliação (f) e pago depois da expiração (g).
- Tempo estimado: 1 h para preparar (ngrok, conta e credenciais do Mercado Pago), cerca de 30 min para os casos do sandbox (o caso e espera alguns minutos) e mais 1 h para o bloco final.
- Há coisas que **nunca foram testadas contra o Mercado Pago real** (formato real do `x-signature`, corpo do webhook, `PUT` de cancelamento, e-mail do pagador). É isso que a homologação descobre. Falha vira spec de correção própria, não conserto durante o roteiro: anote o sintoma e siga.
- Três pontos não foram confirmados na documentação e ficam como **verificação durante a execução**: o prefixo do Access Token, o botão “Simular notificação” do painel e se a `notification_url` e o webhook do painel disparam juntos. Também não estão confirmados o valor mínimo do Pix e a regra do e-mail do pagador.

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

Fonte: documentação oficial do ngrok. Os links estão na seção 9.

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

Sem conta, mas a URL `https://<algo>.trycloudflare.com` **muda a cada subida**. Toda vez que mudar, você atualiza `MP_NOTIFICATION_URL` no `apps/api/.env`, reinicia a API e troca a URL no painel do Mercado Pago. Instalação pelo repositório `apt` da Cloudflare ([Downloads](https://developers.cloudflare.com/tunnel/downloads/)); depois:

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

O passo a passo exato muda no painel do Mercado Pago; confira cada tela na documentação, linkada na seção 9.

### 3.1 Aplicação e credenciais de teste

1. Em <https://www.mercadopago.com.br/developers/panel/app> crie uma aplicação (produto "Checkout Transparente" / API de pagamentos, pois a loja chama `POST /v1/payments`).
2. Em **Credenciais**, selecione o ambiente de **Teste**. Copie o **Access Token de teste**. Segundo a documentação, as credenciais de teste são as que validam a integração ([Contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/test/accounts)). O prefixo do token de teste (`TEST-` ou `APP_USR-`) **não foi confirmado**; a API aceita qualquer token com 8 a 500 caracteres, então cole o que o painel mostrar.

### 3.2 Contas de teste (vendedor e comprador)

Ao criar a aplicação, o Mercado Pago gera uma conta de teste sozinho; dá para criar até 15. Em **Integrações → Contas de teste → Criar conta de teste**, crie um **vendedor** e um **comprador** do mesmo país (Brasil). As contas de teste servem para simular outro login; a documentação diz que não são necessárias para testar a integração em si ([Contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/test/accounts)).

### 3.3 Webhook no painel

Em **Suas integrações → sua aplicação → Webhooks → Configurar notificações** ([Webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/notifications/webhooks)):

1. Na **URL modo teste**, coloque `https://<seu-dominio>.ngrok-free.app/api/webhooks/mercadopago`.
2. Marque o evento **Pagamentos** (`payment`). Não marque "Order".
3. **Salvar**. O painel gera a **assinatura secreta**: revele-a em Webhooks → Configurar notificação. Ela vai para `MP_WEBHOOK_SECRET` (seção 4).
4. Se o painel tiver o botão para **simular** o envio de uma notificação, use-o no caso h-2 (não confirmei que ele exista nem o nome exato).

A loja também manda a `notification_url` em cada Pix criado (`MP_NOTIFICATION_URL`). A documentação diz que a URL informada na criação do pagamento tem prioridade sobre a do painel, mas **não diz se os dois disparam**. O caso d registra o que acontece.

### 3.4 O que o sandbox não cobre: Pix aprovado

Não achei na documentação oficial como aprovar um Pix de teste criado por `POST /v1/payments` (a loja usa essa API):

- A página de [Integrar Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix) mostra só a criação (resposta `pending`).
- O valor `APRO` em `payer.first_name` aprova sozinho o Pix de teste da API de Orders ([Realizar uma compra teste com Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix)), mas essa é `/v1/orders`, e a loja não manda `first_name`.
- A Central de Ajuda ([Posso pagar com Pix em ambiente de teste?](https://www.mercadopago.com.br/ajuda/pagar-pix-ambiente-de-teste_36545)) aparece nas buscas dizendo que Pix não é pago em teste; a página bloqueou a leitura automática (403), então **leia você**.

Por isso, o sandbox cobre os casos **a, b, c, e, h e i**. Os casos que precisam de Pix **aprovado** (d, f, g) estão no **bloco final (seção 9)**, com um Pix real de valor mínimo. Se, ao executar, você descobrir que o sandbox aprova o Pix (por exemplo, por uma ação no painel), anote na tabela da seção 8: isso é uma descoberta útil, não uma falha do roteiro.

## 4. Onde colocar cada valor

Nenhum valor real vai para arquivo versionado. `apps/api/.env` e `apps/web/.env.local` estão no `.gitignore`.

| Variável                             | Arquivo / lugar        | De onde vem                                       | Exemplo (fictício)                                              |
| ------------------------------------ | ---------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`                       | `apps/api/.env`        | já vem do `.env.example`                          | `postgres://otilc:otilc@localhost:5432/otilc`                   |
| `WEB_ORIGIN`                         | `apps/api/.env`        | padrão do `.env.example`; não mude                | `http://localhost:3000`                                         |
| `MP_ACCESS_TOKEN`                    | `apps/api/.env`        | Credenciais de teste (3.1)                        | `TEST-xxxx`                                                     |
| `MP_WEBHOOK_SECRET`                  | `apps/api/.env`        | assinatura secreta do Webhooks (3.3)              | `segredo-ficticio`                                              |
| `MP_NOTIFICATION_URL`                | `apps/api/.env`        | URL do túnel + caminho do webhook (2.2)           | `https://<seu-dominio>.ngrok-free.app/api/webhooks/mercadopago` |
| `ORDER_HOLD_MINUTES`                 | `apps/api/.env`        | só para o teste (mínimo da API é 5)               | `5`                                                             |
| `PAYMENT_RECONCILIATION_INTERVAL_MS` | `apps/api/.env`        | só para o teste (mínimo da API é 30000)           | `30000`                                                         |
| `API_URL`, `NEXT_PUBLIC_API_URL`     | `apps/web/.env.local`  | padrão do `.env.example`: `http://localhost:3333` | não mude                                                        |
| URL do webhook (modo teste)          | painel do Mercado Pago | túnel + `/api/webhooks/mercadopago` (3.3)         | `https://<seu-dominio>.ngrok-free.app/api/webhooks/mercadopago` |

- `MP_NOTIFICATION_URL` precisa ser `https`; a API recusa subir com outra coisa.
- Não defina `NODE_ENV=production`: produção exige `DATABASE_CA_CERT` e `WEB_ORIGIN` https, que não existem aqui.
- **Depois de mudar o `apps/api/.env`, pare a API (Ctrl+C) e rode `npm run dev` de novo**: ela só lê o `.env` ao iniciar. Se mudar de URL de túnel, mude nos dois lugares (`.env` e painel).
- No fim do roteiro, restaure `ORDER_HOLD_MINUTES` (padrão 30) e `PAYMENT_RECONCILIATION_INTERVAL_MS` (padrão 300000), ou apague as duas linhas.

Suba tudo: túnel (2.2) em um terminal, e em outro `npm run dev` (API em `:3333`, loja em `:3000`).

## 5. Casos de teste

Marque OK ou FALHA em cada um e preencha a tabela da seção 8. Para as consultas `psql`, veja a seção 6. “Log da API” é a saída do terminal do `npm run dev`; “ngrok” é <http://127.0.0.1:4040>.

### a) Smoke test

- **Ação:** `scripts/smoke.sh http://localhost:3333 http://localhost:3000`
- **Esperado:** cinco linhas `OK` (health, lista de produtos, home, página de produto, login do admin) e `Smoke test concluído: tudo certo.` O script só faz `GET`.
- **Resultado:** [ ] OK [ ] FALHA

### b) Primeiro admin e login

- **Ação:** `npm run admin:create -w @otilc/api`. Responda e-mail (ex.: `admin@example.com`), nome, papel `OWNER` e uma senha de teste com 12 ou mais caracteres, digitada sem eco. Depois abra <http://localhost:3000/admin/login> e entre. O login admin aceita 5 tentativas por minuto.
- **Esperado:** o script confirma a criação; o login leva ao painel, e a lista de pedidos abre em `/admin/orders`.
- **Resultado:** [ ] OK [ ] FALHA

### c) Pedido e Pix gerado

- **Ação:** em <http://localhost:3000> escolha uma peça, o tamanho, “Adicionar ao carrinho”, abra o carrinho e preencha Nome, E-mail e WhatsApp com DDD. Use no e-mail o da **conta comprador de teste** (copie do painel; ele é gravado no seu banco local e **enviado ao Mercado Pago como pagador**), ou `comprador@example.com` se o Mercado Pago aceitar; não use o e-mail da conta vendedor. Clique em “Finalizar pedido”.
- **Esperado (tela):** redireciona para `/pedido/<id>` com “Aguardando pagamento”, o QR code e o Pix copia e cola, e uma contagem de 5 minutos.
- **Esperado (banco):** `orders.status = PENDING_PAYMENT`; uma linha em `payments` com `status = PENDING` e `amount_cents` igual ao total; `variants.reserved` da peça subiu.
- **Se aparecer “Pix indisponível”:** a API respondeu 503. Olhe o log da API: `Falha ao criar o Pix do pedido ...: Mercado Pago respondeu NNN.` traz o código HTTP do Mercado Pago; `Mercado Pago indisponível (rede)` ou `(tempo esgotado)` é falha de conexão; `Resposta inesperada ao criar o Pix.` é resposta fora do formato esperado (anote). **Sem nenhuma linha nova no log**, falta alguma das três `MP_*` no `apps/api/.env` (ou a API não foi reiniciada depois de editar). Nunca cole o corpo da resposta ou o token em lugar nenhum.
- **Resultado:** [ ] OK [ ] FALHA

### e) Pedido não pago expira e o Pix é cancelado

- **Ação:** crie um pedido como no caso c e **não pague**. Deixe passar o prazo (`ORDER_HOLD_MINUTES=5`) mais o intervalo do job (a cada 60 s): cerca de 6 minutos.
- **Esperado (log da API):** `N pedido(s) expirado(s); estoque liberado.` Com só este pedido vencido, `N` é 1; se outro pedido pendente (por exemplo, o do caso c) vencer na mesma rodada do job, `N` conta os dois.
- **Esperado (tela):** a página do pedido passa a “Pedido expirado” aos 5 minutos, pela contagem do navegador, **antes** de o job rodar. A prova da expiração é o log e o banco, não a tela.
- **Esperado (banco):** `orders.status = EXPIRED`; `variants.reserved` voltou ao valor de antes; `payments.status = CANCELLED`. A API só registra no log quando o cancelamento **falha** (`Cancelamento do Pix <id> falhou: ...`); ausência dessa linha e `CANCELLED` no banco são o sinal de que o `PUT` no Mercado Pago foi aceito.
- **Esperado (Mercado Pago):** o pagamento aparece como cancelado se você consultar `GET /v1/payments/<id>` com o seu token (ou no painel, se houver tela de pagamentos de teste).
- **Resultado:** [ ] OK [ ] FALHA

### h) Assinatura inválida → 401

h-1, sem o Mercado Pago. Direto na API local:

```bash
curl -i -X POST 'http://localhost:3333/api/webhooks/mercadopago?data.id=123456&type=payment' \
  -H 'content-type: application/json' \
  -H 'x-request-id: teste-assinatura-invalida' \
  -H "x-signature: ts=$(date +%s),v1=0000000000000000000000000000000000000000000000000000000000000000" \
  -d '{"type":"payment","data":{"id":"123456"}}'
```

- **Esperado:** `HTTP/1.1 401` com a mensagem `Assinatura inválida.` O `ts` é o horário atual (dentro da janela de ±5 min) e o `v1` é um HMAC errado, então o 401 vem da conferência da assinatura, não de timestamp vencido. Nada gravado em `payment_notifications`.

h-2, só se o painel tiver o botão de simular notificação (3.3): dispare-o para a URL do túnel.

- **Esperado:** `200` em `:4040` (o id simulado não é de nenhuma cobrança da loja, então a API só registra `Notificação de pagamento desconhecido ...; ignorada.` no log e não muda nada). Isso prova que a assinatura **real** do Mercado Pago passa na validação. Um `401` aqui indica relógio errado (2.1), segredo diferente do painel ou formato de assinatura diferente do esperado: anote os headers (sem o segredo).
- **Resultado:** h-1 [ ] OK [ ] FALHA — h-2 [ ] OK [ ] FALHA [ ] não existe

### i) Admin marca o pedido como enviado

Precisa de um pedido `PAID`. No sandbox o Pix não é aprovado (3.4), então crie um **pedido novo** (como no caso c) e use o botão “Marcar pago” do painel **antes de ele vencer** (5 minutos; o painel e a API recusam marcar pago um pedido vencido, como o do caso e), só para chegar ao botão de envio; isso **não** prova o Pix. (Com o pedido pago de verdade do bloco final, repita este passo se quiser.)

- **Ação:** em `/admin/orders`, abra o pedido pago e clique em “Marcar enviado”.
- **Esperado:** `orders.status = SHIPPED`; o botão some.
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

| Sintoma                                                                         | Causa provável e o que fazer                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook responde `401 Assinatura inválida`                                      | Relógio do WSL fora (2.1); `MP_WEBHOOK_SECRET` diferente da assinatura do painel (ela muda se você a redefinir; reinicie a API depois de atualizar o `.env`); notificação de um app/conta diferente da configurada.                                                                                             |
| Loja mostra “Pix indisponível” (503)                                            | Falta alguma das três `MP_*` no `apps/api/.env` (e a API não foi reiniciada), ou o Mercado Pago recusou a criação: veja o código HTTP na linha `Falha ao criar o Pix` no log da API.                                                                                                                            |
| A API não sobe com “Configuração inválida”                                      | A mensagem lista só os nomes das variáveis. `MP_NOTIFICATION_URL` precisa ser https; `ORDER_HOLD_MINUTES` ≥ 5; `PAYMENT_RECONCILIATION_INTERVAL_MS` entre 30000 e 3600000.                                                                                                                                      |
| Webhook não chega à API                                                         | Túnel caído ou outra URL (o cloudflared muda a cada subida; atualize `.env` e painel); a URL do painel não termina em `/api/webhooks/mercadopago`; veja a requisição em `http://127.0.0.1:4040`.                                                                                                                |
| `403 Origem não permitida` no login do admin                                    | Abriu a loja por outro endereço que não `http://localhost:3000` (a API compara a origem exata em `WEB_ORIGIN`). Use `localhost`, não `127.0.0.1` nem o domínio do túnel.                                                                                                                                        |
| Login do admin bloqueado (`429`)                                                | O login aceita 5 tentativas por minuto por IP. Espere 1 minuto.                                                                                                                                                                                                                                                 |
| `429` ao criar pedido                                                           | A criação de pedido aceita 10 por minuto por IP. Espere 1 minuto.                                                                                                                                                                                                                                               |
| Pedido expirado não aceita Pix (`409`, “Este pedido não pode mais ser pago: …”) | Um pedido expirado não é reaproveitado: crie outro pedido. O estoque já foi devolvido.                                                                                                                                                                                                                          |
| Peça sem estoque ao criar outro pedido                                          | Cada peça tem uma unidade; ela fica reservada enquanto o pedido está `PENDING_PAYMENT`. Espere expirar ou use outra peça. `npm run db:seed` recarrega o catálogo, mas faz `TRUNCATE ... CASCADE`: **apaga pedidos, pagamentos, alertas e o produto de teste da seção 9.1**. Anote os resultados antes de rodar. |

## 8. Resultado para enviar à Bússola

| Caso | O que prova                                     | OK / FALHA / não executável | Observações (sintoma, log, código HTTP; nunca segredo) |
| ---- | ----------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| a    | smoke test local                                |                             |                                                        |
| b    | primeiro admin e login                          |                             |                                                        |
| c    | pedido e Pix gerado                             |                             |                                                        |
| d    | (bloco final) Pix pago → webhook → PAID         |                             | disparou: painel / notification_url / os dois          |
| e    | expiração e Pix cancelado                       |                             |                                                        |
| f    | (bloco final) webhook perdido → conciliação     |                             |                                                        |
| g    | (bloco final) pago depois da expiração → alerta |                             |                                                        |
| h-1  | assinatura inválida → 401                       |                             |                                                        |
| h-2  | simulação do painel → 200                       |                             |                                                        |
| i    | admin marca enviado                             |                             |                                                        |

Também envie: formato real do `x-signature`/`x-request-id` que chegou (sem o segredo), o prefixo do Access Token de teste e qualquer comportamento diferente do esperado.

## 9. Bloco final: Pix real de cerca de R$ 1 (credenciais de produção)

> **ATENÇÃO. Faça este bloco só depois de fechar as seções 1 a 8.**
>
> - Aqui entram as credenciais de **PRODUÇÃO** do Mercado Pago, da conta do **seu próprio** Mercado Pago (**não** a da conta do cliente nem de ninguém mais). Pagamento real: o dinheiro (cerca de R$ 1) sai da sua conta bancária e cai na sua conta do Mercado Pago, com a tarifa do Mercado Pago.
> - Elas ficam **somente** no `apps/api/.env` local. Nada de commit, chat, print com o token à mostra, Render, Vercel ou qualquer deploy.
> - A API continua em `localhost`, com `NODE_ENV` de desenvolvimento, atrás do túnel. **Enquanto o túnel estiver de pé, toda a API local fica acessível na internet** (inclusive o login do admin): use uma senha de teste forte, suba o túnel só quando for usar e derrube-o ao terminar o bloco.
> - Ao fim, volte às credenciais de teste (9.5) e revogue ou troque as de produção (9.6).

Este bloco cobre os casos **d, f e g**, que exigem um Pix aprovado.

### 9.1 Pedido de cerca de R$ 1, sem mudar código

O preço sempre vem do banco (`priceCents`) e o `ORDER_HOLD_MINUTES` mínimo é 5; nenhum valor mínimo de pedido é imposto pela loja. Então crie um **produto de teste** de R$ 1,00 pelo painel do admin local (a sessão do caso b é `OWNER`):

1. Confira o slug de uma categoria: `docker compose exec db psql -U otilc -d otilc -c "SELECT slug FROM categories"` (o catálogo do Drop 00 traz `tenis`, `camisetas`, `calcas`, `casacos`, `bones`; use o que o `SELECT` mostrar).
2. Em <http://localhost:3000/admin/products/new> preencha: Nome `Produto de teste Pix`, Slug `produto-de-teste-pix`, Categoria (slug) `camisetas` (ou o do passo 1), Preço em centavos **`100`**, Status **`ACTIVE`**. Os outros campos podem ficar vazios; “Condição”, se pedir, `10`. Clique em “Salvar produto” **uma vez** e confira o aviso “Produto salvo.”. A tela continua em `/admin/products/new`; salvar de novo recusa o slug repetido.
3. “Nova variação” só existe na tela de edição do produto: vá em <http://localhost:3000/admin>, ache “Produto de teste Pix” na lista e clique em **Abrir**. Em “Nova variação” preencha (`color` pode ficar vazio) e clique em “Criar variação”: crie `sku` `TESTE-PIX-1`, `size` `U`, `stock` `5` (use mais estoque do que os 3 pedidos dos casos d, f e g; cada pedido reserva 1 unidade até pagar ou expirar).
4. Na loja, o produto aparece em <http://localhost:3000/produto/produto-de-teste-pix>. A loja guarda o catálogo em cache por 30 s: se o produto ou o tamanho `U` não aparecer, espere 30 s e recarregue. O total do pedido deve ser **R$ 1,00**. O menor valor que o Pix do Mercado Pago aceita **não foi confirmado**: se a criação falhar com R$ 1,00 (veja o log da API, `Mercado Pago respondeu NNN`; se vier `400`, as causas prováveis são o valor mínimo ou o e-mail do pagador igual ao da conta; anote e teste uma de cada vez), suba o preço para `500` (R$ 5,00) e anote.
5. No fim, para tirar o produto da vitrine: altere o status para `DRAFT` (a API não tem exclusão de produto).

### 9.2 Credenciais de produção e webhook de produção

1. No painel do Mercado Pago ([Suas integrações](https://www.mercadopago.com.br/developers/panel/app)), na **mesma** aplicação, abra **Credenciais** e selecione o ambiente de **Produção** (ativar produção pode pedir dados da conta; siga o painel). Copie o **Access Token de produção**. Não cole em nenhum lugar fora do `apps/api/.env`.
2. Em **Webhooks → Configurar notificações**, preencha a **URL modo produção** com `https://<seu-dominio>.ngrok-free.app/api/webhooks/mercadopago`, marque **Pagamentos** e salve. Revele a **assinatura secreta de produção** (ela é **diferente** da de teste).
3. Anote os valores antigos (de teste) em um bloco de notas **fora do repositório**, só para o passo 9.5.

### 9.3 Trocar o `.env` e subir

No `apps/api/.env` substitua `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` pelos de **produção** (os placeholders de exemplo da seção 4 mostram o formato). `MP_NOTIFICATION_URL`, `ORDER_HOLD_MINUTES=5` e `PAYMENT_RECONCILIATION_INTERVAL_MS=30000` continuam como estão. Pare a API (Ctrl+C), rode `npm run dev` e suba o túnel (`ngrok http 3333`). Use sempre o produto `produto-de-teste-pix`, com um e-mail **diferente** do da sua conta do Mercado Pago (ele é enviado ao Mercado Pago como pagador).

### 9.4 Casos

**d) Pix pago → webhook → pedido `PAID`**

- **Ação:** crie o pedido (caso c, com o produto de R$ 1,00). Com a página do pedido aberta, pague o Pix copia e cola pelo app do seu banco.
- **Esperado (ngrok):** em <http://127.0.0.1:4040> aparece `POST /api/webhooks/mercadopago?data.id=<id>&type=payment` com resposta `200`. Anote os headers `x-signature` e `x-request-id` (sem copiar o segredo).
- **Esperado (tela):** “Pagamento confirmado”. A página consulta a API a cada 5 s e a API consulta o Mercado Pago no máximo a cada 20 s, então a tela pode atualizar **sem** o webhook. Quem prova o webhook é a consulta abaixo.
- **Esperado (banco):** `orders.status = PAID`; `payments.status = APPROVED` com `approved_at` preenchido; `variants.stock` caiu 1 e `reserved` voltou; **`payment_notifications` tem ao menos uma linha** para o `provider_payment_id`.
- **Formato antigo:** podem chegar requisições no formato antigo (`?id=...&topic=...`), que a API recusa com `400` porque a query exige `data.id`. Se aparecerem em `:4040`, anote; não são falha do caso.
- **Duplicatas:** conte as linhas de `payment_notifications` desse pagamento e as requisições em `:4040`. Anote se disparou só o webhook do painel, só a `notification_url` do pagamento ou os dois (uma linha por `x-request-id` diferente). O segundo é processado sem efeito (`already_approved`).
- **Resultado:** [ ] OK [ ] FALHA — disparou: [ ] painel [ ] notification_url [ ] os dois

**f) Webhook perdido → conciliação**

- **Ação:** crie um pedido novo (caso c). Quando o QR aparecer, **copie o Pix copia e cola** e guarde (o código só existe nessa aba, e reabrir `/pedido/<id>` faria a página consultar o Mercado Pago e mascarar o teste). Feche a aba. Derrube o túnel (Ctrl+C no ngrok). **Pague entre 2 e 3 minutos depois de criar o pedido**, com o código copiado. Espere. Suba o túnel de novo só depois do resultado.
- **Por que 3 minutos:** com `ORDER_HOLD_MINUTES=5` o pedido vence aos 5 min. A conciliação roda a cada 30 s e só olha Pix com mais de 2 min, então confirma até ~30 s depois dos 2 min (nunca antes de 2 min da criação do Pix) e antes do vencimento aos 5 min. Pagar antes dos 2 min também funciona, mas a conciliação só confirma quando o Pix completar 2 min. Se o pagamento passar do prazo, o resultado certo é o do caso g (`PAID_AFTER_EXPIRY`), não o deste: refaça com outro pedido. Alternativa: ponha `ORDER_HOLD_MINUTES=30` no `apps/api/.env` e reinicie a API antes deste caso, e volte para `5` (reiniciando) antes do caso g.
- **Esperado (banco, é o critério do OK):** `orders.status = PAID` e `payments.status = APPROVED`, sem linha nova em `payment_notifications` para esse pagamento.
- **Log da API:** a linha `Conciliação: N pagamento(s) conferido(s), 0 com falha.` aparece a cada rodada que confere alguma cobrança `PENDING` (inclusive antes de você pagar) e **não serve de prova**.
- **Obs.:** o Mercado Pago reenvia webhooks não confirmados (a documentação cita novas tentativas a cada 15 minutos); se um reenvio chegar depois, ele não muda nada.
- **Resultado:** [ ] OK [ ] FALHA

**g) Pix pago depois da expiração → `PAID_AFTER_EXPIRY` (se der)**

É o caso mais difícil de armar: o job cancela o Pix cerca de 1 minuto depois de o pedido expirar, então a janela é curta. A saída é manter a API parada. O Pix real vale 31 minutos; o pedido, 5.

- **Ação:** crie o pedido novo; quem cria o Pix é a página ao carregar. Quando o QR aparecer, **copie o Pix copia e cola**: aos 5 min a tela troca para “Pedido expirado” e o QR some, e com a API parada recarregar não traz o código de volta. Em seguida **pare a API na hora**, antes dos 5 minutos do prazo (Ctrl+C no `npm run dev`, que derruba a API e a loja juntas): o job de expiração roda a cada 60 s e, se pegar o pedido vencido com a API no ar, cancela o Pix no Mercado Pago e o pagamento deixa de ser possível. Espere passar 6 minutos. Pague com o código copiado. Rode `npm run dev` de novo.
- **Esperado (log da API), nesta ordem:** primeiro (cerca de 30 s depois de subir) o aviso `Pagamento <id> do pedido <id>: alerta PAID_AFTER_EXPIRY.` (com os ids reais); depois (cerca de 60 s) `1 pedido(s) expirado(s); estoque liberado.`
- **Esperado (banco):** `orders.status = EXPIRED` (o pedido **não** vira `PAID`); `payments.status = APPROVED`; uma linha em `payment_alerts` com `alert = PAID_AFTER_EXPIRY`.
- **Depois:** o Mercado Pago não devolve o dinheiro sozinho. O estorno é manual, no painel do Mercado Pago (o contrato da API chama isso de estorno manual).
- **Resultado:** [ ] OK [ ] FALHA [ ] não deu para armar

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

Mercado Pago:

- [Contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/test/accounts)
- [Integrar Pix (API de pagamentos)](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix)
- [Notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/notifications) e [Webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/notifications/webhooks)
- [Realizar uma compra teste com Pix (API de Orders, outro produto)](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix)
- [Posso pagar com Pix em ambiente de teste?](https://www.mercadopago.com.br/ajuda/pagar-pix-ambiente-de-teste_36545)

Contrato da própria API: [docs/api/pagamentos.md](api/pagamentos.md).
