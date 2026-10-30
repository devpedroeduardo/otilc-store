# API de pagamentos (Pix)

Contrato dos endpoints de pagamento por Pix com o Mercado Pago (sandbox). Decisões na [spec-014](../../specs/014-pix-mercado-pago.md), na [spec-015](../../specs/015-conciliacao-pix.md) (conciliação, cancelamento e alertas) e na [spec-021](../../specs/021-pix-api-de-orders.md) (troca para a API de Orders do Mercado Pago).
Schemas e DTOs citados aqui estão em [`packages/shared/src/payments.ts`](../../packages/shared/src/payments.ts).

## Regras gerais

- **O valor nunca vem do navegador.** A cobrança usa sempre `orders.totalCents`, lido do banco. Nenhum endpoint aceita valor no corpo.
- **A loja usa só a API de Orders do Mercado Pago** (`/v1/orders`, spec-021): cada cobrança Pix é uma order com uma transação Pix. `payments.provider_payment_id` guarda o **id da order** (`ORD` seguido de 26 a 40 letras maiúsculas e dígitos, `mercadoPagoOrderIdSchema`); o id da transação (`PAY…`) não é guardado. Id fora desse formato nunca chega ao Mercado Pago.
- **O status do pagamento vem só da API do Mercado Pago** (`GET /v1/orders/{id}`). A notificação do webhook é só um aviso para ir conferir; o status escrito no corpo dela é ignorado.
- **Uma transição só.** Webhook, verificação sob demanda, conciliação periódica e cancelamento do Pix expirado usam a mesma função para mudar o pedido. A mudança `PENDING_PAYMENT → PAID` é condicional e acontece uma vez, com o mesmo efeito no estoque do painel (`reserved -= qtd` e `stock -= qtd`, ver [admin.md](admin.md)).
- IDs na rota são UUID; ID malformado responde `400`, ID inexistente `404`. As rotas seguem o limite global de requisições (120/min por IP, `429`), menos o webhook, que tem limite próprio de 600/min por IP.
- Logs nunca registram token, segredo, header de assinatura, QR code nem e-mail ou nome do cliente.
- **Erro do Mercado Pago** (qualquer status HTTP de erro, inclusive `429`) gera um aviso de diagnóstico no log: método, rota sem o id (ex.: `POST /v1/orders/{id}/cancel`), status HTTP e o código e a mensagem de erro do corpo do Mercado Pago, numa linha, truncada em 120 caracteres, com e-mail e nome do pagador trocados por marcadores. Sem retry: `429` é tratado como as outras falhas (`503` na criação, falha contada no backoff da conciliação).

### Pix desligado

O Pix depende de `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET`. Em produção a API não sobe sem elas. Fora de produção, se faltar qualquer uma, o Pix fica desligado: `POST /api/orders/:id/pix` responde `503 PIX_UNAVAILABLE`. O resto da loja (catálogo, carrinho, pedido e reserva) continua funcionando.

`MP_NOTIFICATION_URL` deixou de existir (spec-021): a API de Orders não aceita URL de notificação na order. Se a variável sobrar no ambiente, é ignorada.

### Webhook no painel do Mercado Pago

A URL do webhook é configurada só no painel: **Suas integrações → sua aplicação → Webhooks**, evento **"Order (Mercado Pago)"**, com a URL `<URL pública da API>/api/webhooks/mercadopago`, nas abas **teste** e **produção** (mesma URL). A assinatura secreta mostrada ali é o `MP_WEBHOOK_SECRET`. Depois da virada para a API de Orders, o evento de **Pagamentos** pode ser desligado: as notificações `type=payment` que ainda chegarem são ignoradas com `200`.

### Erros

Formato padrão do NestJS. Os erros próprios do Pix trazem também `code` (`pixErrorResponseSchema`), para a loja escolher o texto sem depender da mensagem:

| `code`              | Status | Quando                                                                      | `message` (`pixErrorMessages`)                                                                       |
| ------------------- | ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ORDER_NOT_PAYABLE` | `409`  | Pedido não está `PENDING_PAYMENT` ou o prazo (`expiresAt`) já passou        | Este pedido não pode mais ser pago: ele já foi pago, foi cancelado ou o prazo para pagamento acabou. |
| `PIX_UNAVAILABLE`   | `503`  | Pix desligado (variáveis ausentes) ou Mercado Pago fora / resposta inválida | O pagamento por Pix está indisponível no momento. Tente de novo em instantes.                        |

```json
{
  "statusCode": 409,
  "code": "ORDER_NOT_PAYABLE",
  "message": "Este pedido não pode mais ser pago: ele já foi pago, foi cancelado ou o prazo para pagamento acabou.",
  "error": "Conflict"
}
```

## Endpoints

| Método | Rota                        | Corpo / query                                                               | Sucesso                                              | Erros                   |
| ------ | --------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------- |
| `POST` | `/api/orders/:id/pix`       | —                                                                           | `201` `PixChargeDto` (criada) ou `200` (já pendente) | 400, 404, 409, 429, 503 |
| `GET`  | `/api/orders/:id/pix`       | —                                                                           | `200` `PixChargeDto`                                 | 400, 404, 429           |
| `POST` | `/api/webhooks/mercadopago` | query `mercadoPagoWebhookQuerySchema`, corpo `mercadoPagoWebhookBodySchema` | `200` (inclusive duplicada ou ignorada)              | 400, 401, 429, 500      |

## Detalhes por endpoint

### `PixChargeDto`

```json
{
  "orderId": "3b241101-e2bb-4255-8caf-4136c566a962",
  "orderStatus": "PENDING_PAYMENT",
  "status": "PENDING",
  "amountCents": 25980,
  "qrCode": "00020126580014br.gov.bcb.pix…",
  "qrCodeBase64": "iVBORw0KGgoAAAANSUhEUgAA…",
  "expiresAt": "2026-10-28T15:30:00.000Z"
}
```

| Campo          | Significado                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `orderId`      | Id do pedido (UUID).                                                                                           |
| `orderStatus`  | Status do pedido no mesmo instante (`PENDING_PAYMENT`, `PAID`, `CANCELED`, `EXPIRED`, `SHIPPED`).              |
| `status`       | Status da cobrança: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` ou `REFUNDED`.                              |
| `amountCents`  | Valor cobrado em centavos, igual ao `totalCents` do pedido.                                                    |
| `qrCode`       | Código Pix "copia e cola".                                                                                     |
| `qrCodeBase64` | Imagem PNG do QR code em base64, sem o prefixo `data:` (a loja monta `data:image/png;base64,…`).               |
| `expiresAt`    | Prazo para pagar, com fuso: o vencimento da reserva do pedido. A contagem regressiva da página usa este campo. |

A página considera o pagamento confirmado quando `orderStatus` é `PAID`, e para de consultar quando `orderStatus` sai de `PENDING_PAYMENT` ou quando `expiresAt` passa.

### `POST /api/orders/:id/pix` — cria ou devolve a cobrança

Sem corpo. Chamado pela página do pedido logo depois do checkout.

- Pedido inexistente: `404`.
- Pedido que não está `PENDING_PAYMENT`, ou com `expiresAt` vencido: `409 ORDER_NOT_PAYABLE`. Também quando o pedido deixa de ser pagável **enquanto** o Mercado Pago cria o Pix (pago ou cancelado pelo painel, ou vencido): a gravação revalida o pedido travado, nada é gravado, o Pix recém-criado é cancelado no Mercado Pago e a resposta é `409 ORDER_NOT_PAYABLE`.
- Já existe cobrança `PENDING` para o pedido: `200` com ela, **sem** chamar o Mercado Pago.
- Senão, cria a order Pix no Mercado Pago (`POST /v1/orders`) e grava a cobrança: `201`. O Pix vale **31 minutos a partir da criação** (`expiration_time` da transação, `PT31M`): a API de Pagamentos exigia no mínimo 30 minutos, mais 1 de folga, e a margem continua a mesma na API de Orders (spec-021). O prazo para pagar continua sendo o `expiresAt` do pedido; um pagamento aprovado depois dele não paga o pedido e gera o alerta `PAID_AFTER_EXPIRY` (decisão do Pedro, Q13). Se a cobrança anterior terminou `REJECTED` ou `CANCELLED` e o pedido ainda pode ser pago, é criada uma nova tentativa.
- Pix desligado, Mercado Pago fora do ar, erro HTTP (inclusive `429`), tempo esgotado ou resposta fora do formato esperado: `503 PIX_UNAVAILABLE`. O pedido e a reserva não mudam.

Corpo enviado ao Mercado Pago (valores fictícios; o valor é sempre o `totalCents` do banco, convertido para texto sem ponto flutuante):

```json
{
  "type": "online",
  "processing_mode": "automatic",
  "external_reference": "3b241101-e2bb-4255-8caf-4136c566a962",
  "description": "Pedido OTILC #42",
  "total_amount": "259.80",
  "payer": { "email": "ana@example.com", "first_name": "Ana" },
  "transactions": {
    "payments": [
      {
        "amount": "259.80",
        "payment_method": { "id": "pix", "type": "bank_transfer" },
        "expiration_time": "PT31M"
      }
    ]
  }
}
```

`payer.first_name` é o primeiro nome de `orders.customer_name` (no sandbox, o nome `APRO` faz o Mercado Pago aprovar o Pix sozinho). A resposta precisa ter exatamente uma transação Pix com `qr_code` e `qr_code_base64` (em `transactions.payments[0].payment_method`); senão é falha do provedor (`503`).

Garantias: no máximo **uma** cobrança `PENDING` por pedido (índice único parcial no banco). Duas chamadas simultâneas terminam com uma cobrança só, e as duas respostas trazem a mesma cobrança. A chave de idempotência enviada ao Mercado Pago (`X-Idempotency-Key`) é determinística por pedido e tentativa (`otilc-pix-<id do pedido>-<tentativa>`).

### `GET /api/orders/:id/pix` — consulta a cobrança

Sem corpo. Devolve a cobrança **mais recente** do pedido e o status atual do pedido. A página chama a cada 5 segundos enquanto o pagamento está pendente.

- Pedido inexistente ou sem cobrança: `404`.
- **Verificação sob demanda**: se a cobrança está `PENDING` e o pedido `PENDING_PAYMENT`, a API consulta a order no Mercado Pago e aplica a mesma transição do webhook antes de responder. No máximo **uma consulta a cada 20 segundos por pedido**, inclusive com chamadas simultâneas; nas demais a resposta vem só do banco. Cobrança com id antigo (numérico, da API de Pagamentos; só existe no banco local) não é consultada: só um aviso no log com o id interno da cobrança.
- Falha do Mercado Pago na verificação não vira erro: a resposta é `200` com o estado atual do banco. Este endpoint nunca responde `503`.

### `POST /api/webhooks/mercadopago` — notificação do Mercado Pago

Chamada de servidor para servidor: CORS não se aplica. Limite próprio de **600 requisições por minuto por IP** (`429` acima disso), folga para as rajadas do Mercado Pago; o resto da API fica em 120/min. Requisição forjada continua barrada pela assinatura.

Exemplo: `POST /api/webhooks/mercadopago?data.id=ORD01JP84C939T20S0P1DN382FQ6K&type=order`

```http
x-signature: ts=1704908010,v1=<HMAC-SHA256 em hexadecimal, 64 caracteres>
x-request-id: bb56a2f1-6aae-46ac-982e-9dcd3581d08e
```

```json
{
  "action": "order.processed",
  "api_version": "v1",
  "application_id": "1234567890",
  "date_created": "2026-10-28T13:04:58.396Z",
  "live_mode": false,
  "type": "order",
  "user_id": "44444",
  "data": { "id": "ORD01JP84C939T20S0P1DN382FQ6K", "status": "processed" }
}
```

Processamento, nesta ordem:

1. **Query** validada (`mercadoPagoWebhookQuerySchema`): `data.id` alfanumérico, até 64 caracteres, de qualquer tipo de notificação. Inválida: `400`.
2. **Assinatura**: o header `x-signature` traz `ts` e `v1`. A API calcula HMAC-SHA256 com `MP_WEBHOOK_SECRET` sobre o texto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (`data.id` da query como recebido; também vale a forma em minúsculas, que a documentação do Mercado Pago pede para id alfanumérico, como o das orders) e compara com `v1` usando `timingSafeEqual`, conferindo o tamanho antes. O `ts` é aceito em milissegundos (13 dígitos, como no exemplo canônico da documentação oficial) ou em segundos (até 11 dígitos, como no exemplo de 10 dígitos); outro tamanho é `401`. O texto assinado usa o `ts` **cru**, como veio no header; a janela usa o valor convertido para o mesmo instante e exige que ele esteja a no máximo **5 minutos** do relógio do servidor. Header ausente, repetido ou malformado, `x-request-id` ausente, assinatura diferente ou `ts` fora da janela: `401`, nada é gravado. Fonte do texto assinado: SDK oficial `mercadopago/sdk-nodejs` (`src/utils/webhook`); a unidade do `ts` aparece nos dois formatos na documentação, por isso os dois são aceitos. Com o Pix desligado (variáveis ausentes), o webhook responde `503`.
3. **Corpo** validado (`mercadoPagoWebhookBodySchema`): só `type` e `data.id` são lidos; todo o resto, inclusive qualquer status, é descartado. Inválido, ou `data.id` do corpo diferente do da query: `400`.
4. `type` diferente de `order` (inclusive `payment`, da API de Pagamentos): `200`, ignorada, sem consultar o Mercado Pago. Com `type=order`, o `data.id` precisa ser id de order (`mercadoPagoOrderIdSchema`); senão (ex.: numérico): `400`. Order que não é de nenhuma cobrança da loja: `200`, ignorada **sem** registrar o `x-request-id` (se a notificação chegou antes de a cobrança ser gravada, o reenvio é processado normalmente).
5. `x-request-id` já registrado em `payment_notifications`: `200`, sem reprocessar.
6. Consulta a order no Mercado Pago (`GET /v1/orders/{id}`, fora da transação) e, numa transação, aplica a transição e registra o `x-request-id`. Se a consulta ou a transação falhar: `500`, nada é registrado, e o reenvio do Mercado Pago é processado normalmente.

Mapeamento do status da **order** (`status` e `status_detail`, nível da order, não da transação) para a cobrança:

| Order (`status/status_detail`)                                           | Cobrança                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `created`, `action_required/*` (ex.: `waiting_transfer`), `processing/*` | `PENDING`                                                         |
| `processed/accredited`                                                   | `APPROVED`                                                        |
| `processed/partially_refunded`                                           | `APPROVED` + `PAYMENT_REVERSED` (estorno parcial)                 |
| `refunded/*`                                                             | `REFUNDED` (+ `PAYMENT_REVERSED` se a cobrança estava `APPROVED`) |
| `charged_back/*`                                                         | mantém `APPROVED` + `PAYMENT_REVERSED`                            |
| `canceled/*` (com um L) e `failed/expired`                               | `CANCELLED`                                                       |
| `failed/failed`                                                          | `REJECTED`                                                        |
| qualquer outro (inclusive `processed` com outro detalhe)                 | desconhecido: nada muda, só log                                   |

Valor e moeda vêm da order: `total_amount` (texto, ex.: `"259.80"`) vira centavos sem ponto flutuante; formato inválido é falha do provedor. `total_paid_amount`, quando vier, também precisa ser igual ao total do pedido. Moeda: `currency_id` (ou `currency`) quando vier; senão vale `BRL` se `country_code` for `BRA`.

Efeito da transição, pela order vinda da consulta ao Mercado Pago ("aprovada" = `processed/accredited` ou `processed/partially_refunded`):

| Situação                                                                                                                            | Pedido                   | Estoque                           | Cobrança                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- | ------------------------------------------------------- |
| aprovada, referência = pedido, valor (e valor pago) = `totalCents`, moeda `BRL`, pedido `PENDING_PAYMENT`, aprovação `<= expiresAt` | vira `PAID` (uma vez só) | `reserved -= qtd`, `stock -= qtd` | `APPROVED`                                              |
| aprovada com pedido já `EXPIRED` ou `CANCELED`                                                                                      | não muda                 | não muda                          | `APPROVED`, alerta `PAID_AFTER_EXPIRY` (estorno manual) |
| aprovada, pedido ainda `PENDING_PAYMENT`, aprovação `> expiresAt`                                                                   | não muda                 | não muda                          | `APPROVED`, alerta `PAID_AFTER_EXPIRY` (estorno manual) |
| aprovada com valor, valor pago, moeda ou referência divergente                                                                      | não muda                 | não muda                          | alerta `AMOUNT_MISMATCH`                                |
| aprovada com pedido já `PAID` ou `SHIPPED` por outro caminho                                                                        | não muda                 | não muda                          | alerta `DUPLICATE_PAYMENT`                              |
| primeira vez vista já `processed/partially_refunded`                                                                                | como as linhas acima     | como as linhas acima              | também alerta `PAYMENT_REVERSED`                        |
| cobrança já `APPROVED` e `refunded`, `charged_back` ou `processed/partially_refunded` (estorno ou contestação)                      | não muda                 | não muda                          | alerta `PAYMENT_REVERSED`; `refunded` vira `REFUNDED`   |
| `failed`, `canceled`, `refunded` com a cobrança ainda `PENDING`                                                                     | não muda                 | não muda                          | status atualizado                                       |
| status desconhecido, ou `charged_back` com a cobrança ainda `PENDING`                                                               | não muda                 | não muda                          | não muda (só log)                                       |

Uma cobrança nunca volta para `PENDING`, e só uma `PENDING` vira `REJECTED`, `CANCELLED` ou `REFUNDED` por esta linha: uma resposta atrasada (`canceled` do cancelamento, por exemplo) não faz uma `APPROVED` ou `REFUNDED` regredir, e uma `APPROVED` só vira `REFUNDED` pelo estorno. `REFUNDED` é final: nem um `processed` atrasado a aprova de novo ou paga o pedido. Uma `PENDING` que o Mercado Pago já mostra `refunded` (aprovada e estornada entre duas consultas) vira `REFUNDED` sem alerta, porque o pedido nunca foi pago, e gera aviso no log com o id da order e do pedido.

**Momento da aprovação**: a API de Orders não traz data de aprovação (nem na order nem na transação; referência do `GET /v1/orders/{id}`, conferida na spec-021). Vale o `last_updated_date` da order na **primeira vez** que a loja a vê aprovada; mudanças depois disso (ex.: estorno) não mexem em `approved_at`. Sem `last_updated_date`, vale a hora da consulta, com aviso no log, porque essa data decide se o pagamento entrou no prazo do pedido.

Reprocessar um pagamento já aprovado não faz nada. A transação trava o pedido e depois as variações, na mesma ordem do job de expiração e do painel, então webhook e expiração simultâneos terminam com o pedido `PAID` ou `EXPIRED`, nunca os dois.

### Alertas

Os alertas não aparecem na API pública; ficam no banco, no log e no painel de alertas do admin (`/admin/alerts`, rotas em [admin.md](admin.md#alertas-de-pagamento-spec-018)):

| Alerta                   | Quando                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `PAID_AFTER_EXPIRY`      | Aprovado depois do prazo do pedido, ou com o pedido `EXPIRED`/`CANCELED`                                                 |
| `AMOUNT_MISMATCH`        | Aprovado com valor, moeda ou referência diferente do pedido                                                              |
| `DUPLICATE_PAYMENT`      | Aprovado com o pedido já `PAID` ou `SHIPPED` por outro caminho                                                           |
| `PAYMENT_REVERSED`       | Estornado (`refunded`, `processed/partially_refunded`) ou contestado (`charged_back`) depois de aprovado                 |
| `RECONCILIATION_STOPPED` | A conciliação falhou 8 vezes seguidas ao consultar o pagamento e parou de consultá-lo (spec-020); o status dele não muda |

- **Os alertas se acumulam** (decisão do Pedro na spec-015): a tabela `payment_alerts` guarda todos os alertas de cada pagamento, com data, e nenhum apaga ou substitui outro. Exemplo: um Pix pago depois do prazo e depois estornado termina com `PAID_AFTER_EXPIRY` e `PAYMENT_REVERSED`.
- Cada tipo de alerta aparece no máximo uma vez por pagamento (`UNIQUE (payment_id, alert)`): repetir a mesma notificação não grava nem registra nada de novo.
- **Resolução** (spec-018): o admin marca o alerta como resolvido no painel (`resolved_at`, `resolved_by`); o alerta continua no histórico. Resolver não muda pagamento, pedido nem `payments.alert`.
- **Reabertura**: só `RECONCILIATION_STOPPED`. Se a conciliação parar de novo num pagamento cujo alerta já foi resolvido (retomada e mais 8 falhas), o mesmo alerta volta a abrir, com `created_at` novo e novo aviso no log; aberto, segue intacto. Os demais tipos não reabrem: `PAYMENT_REVERSED` é regravado em toda sincronização de um `charged_back` ou estorno parcial (o pagamento local segue `APPROVED`) e reabriria sempre, e os outros só nascem na primeira aprovação.
- `payments.alert` guarda só o primeiro alerta do pagamento e nunca é sobrescrita.
- Todo alerta novo gera um aviso (`warn`) no log com o id do pagamento, o id do pedido e o alerta, sem dados do cliente.
- O estorno ao cliente continua manual, no painel do Mercado Pago.

## Conciliação periódica

A API confere sozinha os pagamentos com o Mercado Pago, para corrigir o que o webhook e a verificação sob demanda perderam. Roda dentro da API, a cada `PAYMENT_RECONCILIATION_INTERVAL_MS` (padrão 5 minutos; de 30 s a 1 h), só com o Pix ligado.

- **Seleção**, até 50 pagamentos por rodada, os nunca conferidos primeiro (`last_checked_at` nulo, depois o mais antigo):
  - `PENDING` criados há mais de 2 minutos (o webhook costuma chegar antes) e há menos de 24 horas;
  - `APPROVED` nos últimos 7 dias e não conferidos há 6 horas, para pegar estorno e contestação;
  - nunca um pagamento conferido há menos de 20 segundos (pela verificação sob demanda ou por outra rodada);
  - nunca um pagamento em espera de nova tentativa (`next_check_at` no futuro) nem um que chegou ao teto de falhas (ver abaixo).
- **Várias instâncias**: a rodada reivindica os pagamentos num único comando (`FOR UPDATE SKIP LOCKED` e `last_checked_at = now()`). Uma instância pula o que outra está reivindicando e, depois do commit, o descarta pela regra dos 20 segundos. Duas rodadas simultâneas nunca consultam o mesmo pagamento.
- **Sem trava aberta**: a consulta ao Mercado Pago só acontece depois de a reivindicação terminar; a mudança de estado é a mesma transição do webhook (tabela acima).
- **Id antigo** (numérico, da API de Pagamentos; só existe no banco local, produção não tem): o pagamento é pulado sem consultar o Mercado Pago, sem contar falha e sem `RECONCILIATION_STOPPED`, com um aviso no log com o id interno da cobrança, e fica **24 horas** fora da seleção (`next_check_at`). Na seleção, ids de order vêm antes dos antigos: ids antigos só usam vagas que sobram no lote e nunca impedem a conferência de um pagamento válido. O pulado não entra no `checked` da rodada.
- **Falha** (erro, `429`, tempo esgotado ou order não encontrada no Mercado Pago; todas contam igual): a rodada segue para o próximo, e um único `UPDATE` (só se ninguém conferiu o pagamento no meio) soma 1 em `payments.check_failures`, agenda a próxima tentativa em `next_check_at` e devolve o `last_checked_at` de antes da reivindicação, então um `APPROVED` não espera as 6 horas, só o backoff. Aviso (`warn`) no log com o id do pagamento, o contador e a próxima tentativa.
- **Backoff** (spec-020): depois da n-ésima falha seguida, a próxima tentativa fica para daqui a `intervalo × 2^(n−1)`, no máximo 1 hora. No padrão de 5 minutos: 5, 10, 20, 40, 60, 60 e 60 minutos. Um pagamento que falha sempre não volta mais ao topo de toda rodada, então pagamentos quebrados não ocupam o lote dos saudáveis.
- **Teto**: na **8ª falha seguida** (cerca de 4 h 15 no padrão; 8 consultas em vez de ~288 em 24 h), a conciliação para de consultar o pagamento e grava o alerta `RECONCILIATION_STOPPED` (uma vez só), com um `error` no log. O pagamento continua `PENDING` ou `APPROVED`; pedido e estoque não mudam. Webhook, expiração, verificação sob demanda e cancelamento pelo painel seguem iguais. Para retomar, o admin usa "Retomar conciliação" no alerta, no painel (`POST /api/admin/alerts/:id/resume-reconciliation`, spec-018): zera `check_failures` e `next_check_at`, sem consultar o Mercado Pago nem resolver o alerta.
- **Sucesso zera**: qualquer resposta do Mercado Pago que passa pela transição (conciliação, webhook, verificação sob demanda ou resposta do cancelamento) zera `check_failures` e `next_check_at`, inclusive para um pagamento no teto, que volta ao fluxo normal. Zerar vale para **toda** resposta do Mercado Pago que passa pela transição, não só para a da conciliação. O alerta `RECONCILIATION_STOPPED` já gravado fica como histórico. A reivindicação grava `next_check_at = now()` como marca da consulta em andamento; uma resposta aplicada no meio (ex.: webhook) apaga a marca, e uma falha dessa rodada que chegue depois não conta, mesmo com o contador já zerado.

## Cancelamento do Pix quando o pedido expira

O job de expiração (a cada minuto) devolve o estoque dos pedidos vencidos e, **depois do commit**, cancela no Mercado Pago a order do Pix `PENDING` de cada um deles (`POST /v1/orders/{id}/cancel`, sem corpo, com `X-Idempotency-Key: otilc-pix-cancel-<id da order>`, a mesma em toda repetição; mesmo timeout das outras chamadas, resposta validada). A resposta passa pela mesma transição:

- `canceled`: a cobrança vira `CANCELLED`.
- **Order não cancelável** (o Mercado Pago recusa com um `4xx` que não é `401`, `403`, `404`, `408` nem `429`; ex.: `order_already_canceled`, ou a order já `processed`): a API consulta a order (`GET`) e aplica o estado real. Já paga (o cliente pagou antes de o cancelamento chegar): o pedido continua `EXPIRED` e a cobrança ganha o alerta `PAID_AFTER_EXPIRY`. Já cancelada ou vencida no Mercado Pago: `CANCELLED`.
- Falha no cancelamento ou na consulta (rede, `5xx`, `429`...): só aviso no log. O estoque já foi devolvido e a conciliação confere o pagamento depois, dentro da janela de 24 horas.

A expiração local continua mandando. A validade do Pix no Mercado Pago (31 minutos) e o prazo do pedido (30 minutos) não mudam; o `expiration_time` da order é só a rede de segurança, e o cancelamento fecha o minuto de diferença entre os dois.

O Pix `PENDING` também é cancelado quando o admin marca o pedido como pago ou o cancela pelo painel, **antes** de o status mudar (falha = nada muda); ver [admin.md](admin.md#cancelamento-do-pix-ao-marcar-pago-ou-cancelar-spec-019).
