# Homologação local: Pix com o Mercado Pago sandbox

Roteiro manual para você provar, na sua máquina (WSL), que a loja gera um Pix no Mercado Pago de **teste**, que o webhook volta por um túnel até a API local e que expiração, cancelamento e conciliação funcionam. Decisões na [spec-017](../specs/017-homologacao-local.md).

> **Nada aqui é produção.** Sem Render, Vercel ou Supabase. A API roda com `NODE_ENV` de desenvolvimento (nunca `production`), contra o Postgres do `docker compose`. Credenciais, segredo do webhook e token do túnel são seus: ficam em `apps/api/.env`, no painel do Mercado Pago e no `ngrok`, nunca no repositório.

## 1. Visão geral

```
navegador ──> loja (localhost:3000) ──> API (localhost:3333) ──> Postgres (docker, :5432)
                                          ^        │
                                          │        └──> api.mercadopago.com (cria / consulta / cancela o Pix)
   Mercado Pago ──> https://<seu-dominio>.ngrok-free.app ──> túnel ngrok ──┘   (webhook)
```

- Só a **API** passa pelo túnel (o webhook é de servidor para servidor). A loja fica em `http://localhost:3000`, então CORS e cookie do admin funcionam sem mudança.
- O que o roteiro prova: Pix gerado (caso c), pago e confirmado por webhook (d), pedido que expira e Pix cancelado no Mercado Pago (e), webhook perdido e conciliação (f), pago depois da expiração (g), assinatura inválida (h) e envio pelo admin (i).
- Tempo estimado: 1 h para preparar (ngrok, conta e credenciais do Mercado Pago) e cerca de 1 h para os casos, já que (e) e (f) esperam alguns minutos.
- Há coisas que **nunca foram testadas contra o Mercado Pago real** (formato real do `x-signature`, corpo do webhook, `PUT` de cancelamento, e-mail do pagador). É isso que a homologação descobre. Falha vira spec de correção própria, não conserto durante o roteiro: anote o sintoma e siga.
- **Aprovar um Pix no sandbox é a maior incógnita** (seção 3.4). Os casos d, f, g e i dependem disso.

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

3. Cadastre o authtoken. Ele fica em <https://dashboard.ngrok.com/get-started/your-authtoken>; cole **no seu terminal**, nunca em arquivo do repositório:

   ```bash
   ngrok config add-authtoken <SEU_AUTHTOKEN>
   ```

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

### 3.4 Aprovar um Pix de teste (não confirmado)

- A documentação do `POST /v1/payments` com Pix ([Integrar Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix)) mostra a criação (resposta `pending`), mas **não descreve como aprovar um Pix de teste**.
- A página de teste de Pix da API de Orders ([Realizar uma compra teste com Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix)) usa o valor `APRO` em `payer.first_name` para aprovar sozinho, mas é de `/v1/orders`, não de `/v1/payments`, que é o que a loja usa. A loja não envia `first_name`, então esse caminho **não** se aplica.
- A Central de Ajuda do Mercado Pago ("Posso pagar com Pix em ambiente de teste?") aparece nas buscas dizendo que **Pix não é pago em ambiente de teste**; a página bloqueou a leitura automática (403) e **não consegui ler o texto**. Leia você: <https://www.mercadopago.com.br/ajuda/pagar-pix-ambiente-de-teste_36545>.

**O que fazer:** tente, nesta ordem, e anote o que funcionou na tabela da seção 8: (1) painel → Integrações → sua aplicação, com o seletor em **Teste**, aba de pagamentos de teste (veja se há ação para aprovar); (2) pagar o QR com a conta de comprador de teste, se o painel orientar; (3) nada disso funcionando, marque **“não executável no sandbox”** nos casos d, f, g e i-aprovação. Eles ficam como “verificar via conciliação/consulta” (`GET /v1/payments/<id>` com o seu token), e a decisão de como seguir é da Bússola/Pedro. Os casos a, b, c, e, h independem disso.

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

- **Ação:** em <http://localhost:3000> escolha uma peça, o tamanho, “Adicionar ao carrinho”, abra o carrinho e preencha Nome, E-mail e WhatsApp com DDD. Use no e-mail o da **conta comprador de teste** (copie do painel; ele só vai para o seu banco local), ou `comprador@example.com` se o Mercado Pago aceitar; não use o e-mail da conta vendedor. Clique em “Finalizar pedido”.
- **Esperado (tela):** redireciona para `/pedido/<id>` com “Aguardando pagamento”, o QR code e o Pix copia e cola, e uma contagem de 5 minutos.
- **Esperado (banco):** `orders.status = PENDING_PAYMENT`; uma linha em `payments` com `status = PENDING` e `amount_cents` igual ao total; `variants.reserved` da peça subiu.
- **Se aparecer “Pix indisponível”:** a API respondeu 503. Veja no log da API a linha `Falha ao criar o Pix do pedido ...: Mercado Pago respondeu NNN.` (o código HTTP do Mercado Pago, que diz o porquê) ou, se a mensagem for sobre variável, confira as três `MP_*`. Nunca cole o corpo da resposta ou o token em lugar nenhum.
- **Resultado:** [ ] OK [ ] FALHA

### d) Pix aprovado → webhook → pedido PAID

Depende de 3.4. Se não der para aprovar o Pix, marque “não executável” e veja o que a consulta `GET /v1/payments/<id>` diz do pagamento.

- **Ação:** com a página do pedido aberta, aprove o Pix de teste pelo método que você achou em 3.4.
- **Esperado (ngrok):** em `:4040` aparece `POST /api/webhooks/mercadopago?data.id=<id>&type=payment` com respostas `200`. Registre também o conteúdo dos headers `x-signature` e `x-request-id` (sem copiar o segredo).
- **Esperado (tela):** em até alguns segundos, “Pagamento confirmado”. (A página consulta a API a cada 5 s, e a API consulta o Mercado Pago, no máximo uma vez por 20 s; por isso a tela pode atualizar **sem** o webhook. Quem confirma que o webhook funcionou é a consulta abaixo, não a tela.)
- **Esperado (banco):** `orders.status = PAID`; `payments.status = APPROVED` com `approved_at` preenchido; `variants.stock` caiu e `variants.reserved` voltou; **`payment_notifications` tem ao menos uma linha** para o `provider_payment_id` (é o registro de que um webhook foi aceito).
- **Duplicatas:** conte as linhas de `payment_notifications` desse pagamento e as requisições em `:4040`. Anote: só o webhook do painel? só a `notification_url` do pagamento? os dois (uma linha por `x-request-id` diferente)? O segundo é processado sem efeito (`already_approved`).
- **Resultado:** [ ] OK [ ] FALHA — disparou: [ ] painel [ ] notification_url [ ] os dois

### e) Pedido não pago expira e o Pix é cancelado

- **Ação:** crie um pedido como no caso c e **não pague**. Deixe passar o prazo (`ORDER_HOLD_MINUTES=5`) mais o intervalo do job (a cada 60 s): cerca de 6 minutos.
- **Esperado (log da API):** `1 pedido(s) expirado(s); estoque liberado.`
- **Esperado (tela):** a página do pedido passa a “Pedido expirado”.
- **Esperado (banco):** `orders.status = EXPIRED`; `variants.reserved` voltou ao valor de antes; `payments.status = CANCELLED`. A API só registra no log quando o cancelamento **falha** (`Cancelamento do Pix <id> falhou: ...`); ausência dessa linha e `CANCELLED` no banco são o sinal de que o `PUT` no Mercado Pago foi aceito.
- **Esperado (Mercado Pago):** o pagamento aparece como cancelado se você consultar `GET /v1/payments/<id>` com o seu token (ou no painel, se houver tela de pagamentos de teste).
- **Resultado:** [ ] OK [ ] FALHA

### f) Webhook perdido → conciliação

Depende de 3.4 (precisa aprovar o Pix).

- **Ação:** crie um pedido (caso c) e **feche a aba `/pedido/<id>`**: a consulta sob demanda da página também confirmaria o pagamento e mascararia este teste. Derrube o túnel (Ctrl+C no ngrok). Aprove o Pix. Espere. Suba o túnel de novo (`ngrok http 3333`) só depois do resultado.
- **Esperado (log da API):** em até cerca de 30 s depois de passados 2 minutos da criação do Pix: `Conciliação: 1 pagamento(s) conferido(s), 0 com falha.`
- **Esperado (banco):** `orders.status = PAID` e `payments.status = APPROVED`, sem linha nova em `payment_notifications` para esse pagamento.
- **Obs.:** o Mercado Pago reenvia webhooks que não foram confirmados (a documentação cita novas tentativas a cada 15 minutos); se um reenvio chegar depois, ele não muda nada.
- **Resultado:** [ ] OK [ ] FALHA

### g) Pix pago depois da expiração → `PAID_AFTER_EXPIRY`

Depende de 3.4. É o caso mais difícil de armar: o job cancela o Pix cerca de 1 minuto depois da expiração, então a janela é curta. A saída é manter a API parada.

- **Ação:** crie o pedido (caso c). **Pare a API** (Ctrl+C no `npm run dev`) logo depois de criado. Espere passar 6 minutos (o pedido já venceu, o Pix ainda vale: ele dura 31 minutos). Aprove o Pix. Suba a API de novo.
- **Esperado (log da API):** um aviso (`warn`) de alerta com o id do pagamento, o id do pedido e `PAID_AFTER_EXPIRY`, e a linha `1 pedido(s) expirado(s); estoque liberado.` (a ordem entre as duas pode variar).
- **Esperado (banco):** `orders.status = EXPIRED` (o pedido **não** vira `PAID`); `payments.status = APPROVED`; uma linha em `payment_alerts` com `alert = PAID_AFTER_EXPIRY`. O estorno ao cliente seria manual no painel do Mercado Pago.
- **Resultado:** [ ] OK [ ] FALHA [ ] não executável

### h) Assinatura inválida → 401

h-1, sem o Mercado Pago. Direto na API local:

```bash
curl -i -X POST 'http://localhost:3333/api/webhooks/mercadopago?data.id=123456&type=payment' \
  -H 'content-type: application/json' \
  -H 'x-request-id: teste-assinatura-invalida' \
  -H 'x-signature: ts=1704908010,v1=0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"type":"payment","data":{"id":"123456"}}'
```

- **Esperado:** `HTTP/1.1 401` com a mensagem `Assinatura inválida.` Nada gravado em `payment_notifications`.

h-2, só se o painel tiver o botão de simular notificação (3.3): dispare-o para a URL do túnel.

- **Esperado:** `200` em `:4040` (o id simulado não é de nenhuma cobrança da loja, então a API só registra `Notificação de pagamento desconhecido ...; ignorada.` no log e não muda nada). Isso prova que a assinatura **real** do Mercado Pago passa na validação. Um `401` aqui indica relógio errado (2.1), segredo diferente do painel ou formato de assinatura diferente do esperado: anote os headers (sem o segredo).
- **Resultado:** h-1 [ ] OK [ ] FALHA — h-2 [ ] OK [ ] FALHA [ ] não existe

### i) Admin marca o pedido como enviado

Precisa de um pedido `PAID`. Se não conseguiu pagar o Pix (3.4), use “Marcar pago” no painel só para testar o botão de envio; isso **não** prova o Pix.

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

| Sintoma                                                   | Causa provável e o que fazer                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook responde `401 Assinatura inválida`                | Relógio do WSL fora (2.1); `MP_WEBHOOK_SECRET` diferente da assinatura do painel (ela muda se você a redefinir; reinicie a API depois de atualizar o `.env`); notificação de um app/conta diferente da configurada. |
| Loja mostra “Pix indisponível” (503)                      | Falta alguma das três `MP_*` no `apps/api/.env` (e a API não foi reiniciada), ou o Mercado Pago recusou a criação: veja o código HTTP na linha `Falha ao criar o Pix` no log da API.                                |
| A API não sobe com “Configuração inválida”                | A mensagem lista só os nomes das variáveis. `MP_NOTIFICATION_URL` precisa ser https; `ORDER_HOLD_MINUTES` ≥ 5; `PAYMENT_RECONCILIATION_INTERVAL_MS` entre 30000 e 3600000.                                          |
| Webhook não chega à API                                   | Túnel caído ou outra URL (o cloudflared muda a cada subida; atualize `.env` e painel); a URL do painel não termina em `/api/webhooks/mercadopago`; veja a requisição em `http://127.0.0.1:4040`.                    |
| `403 Origem não permitida` no login do admin              | Abriu a loja por outro endereço que não `http://localhost:3000` (a API compara a origem exata em `WEB_ORIGIN`). Use `localhost`, não `127.0.0.1` nem o domínio do túnel.                                            |
| Login do admin bloqueado (`429`)                          | O login aceita 5 tentativas por minuto por IP. Espere 1 minuto.                                                                                                                                                     |
| `429` ao criar pedido                                     | A criação de pedido aceita 10 por minuto por IP. Espere 1 minuto.                                                                                                                                                   |
| Pedido expirado não aceita Pix (`409`, “Pedido expirado”) | Um pedido expirado não é reaproveitado: crie outro pedido. O estoque já foi devolvido.                                                                                                                              |
| Peça sem estoque ao criar outro pedido                    | Cada peça tem uma unidade; ela fica reservada enquanto o pedido está `PENDING_PAYMENT`. Espere expirar ou use outra peça. `npm run db:seed` recarrega o catálogo.                                                   |

## 8. Resultado para enviar à Bússola

| Caso | O que prova                                    | OK / FALHA / não executável | Observações (sintoma, log, código HTTP; nunca segredo) |
| ---- | ---------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| 3.4  | método de aprovar Pix no sandbox que funcionou |                             |                                                        |
| a    | smoke test local                               |                             |                                                        |
| b    | primeiro admin e login                         |                             |                                                        |
| c    | pedido e Pix gerado                            |                             |                                                        |
| d    | Pix aprovado → webhook → PAID                  |                             | disparou: painel / notification_url / os dois          |
| e    | expiração e Pix cancelado                      |                             |                                                        |
| f    | webhook perdido → conciliação                  |                             |                                                        |
| g    | pago depois da expiração → alerta              |                             |                                                        |
| h-1  | assinatura inválida → 401                      |                             |                                                        |
| h-2  | simulação do painel → 200                      |                             |                                                        |
| i    | admin marca enviado                            |                             |                                                        |

Também envie: formato real do `x-signature`/`x-request-id` que chegou (sem o segredo), o prefixo do Access Token de teste e qualquer comportamento diferente do esperado.

## 9. Links oficiais

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
