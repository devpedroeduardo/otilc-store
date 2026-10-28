# API de pagamentos (Pix)

Contrato dos endpoints de pagamento por Pix com o Mercado Pago (sandbox). Decisões na [spec-014](../../specs/014-pix-mercado-pago.md).
Schemas e DTOs citados aqui estão em [`packages/shared/src/payments.ts`](../../packages/shared/src/payments.ts).

## Regras gerais

- **O valor nunca vem do navegador.** A cobrança usa sempre `orders.totalCents`, lido do banco. Nenhum endpoint aceita valor no corpo.
- **O status do pagamento vem só da API do Mercado Pago** (`GET /v1/payments/{id}`). A notificação do webhook é só um aviso para ir conferir; o status escrito no corpo dela é ignorado.
- **Uma transição só.** Webhook e verificação sob demanda usam a mesma função para mudar o pedido. A mudança `PENDING_PAYMENT → PAID` é condicional e acontece uma vez, com o mesmo efeito no estoque do painel (`reserved -= qtd` e `stock -= qtd`, ver [admin.md](admin.md)).
- IDs na rota são UUID; ID malformado responde `400`, ID inexistente `404`. Todas as rotas seguem o limite global de requisições (`429`).
- Logs nunca registram token, segredo, header de assinatura, QR code nem e-mail do cliente.

### Pix desligado

O Pix depende de `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `MP_NOTIFICATION_URL`. Em produção a API não sobe sem elas. Fora de produção, se faltar qualquer uma, o Pix fica desligado: `POST /api/orders/:id/pix` responde `503 PIX_UNAVAILABLE`. O resto da loja (catálogo, carrinho, pedido e reserva) continua funcionando.

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
- Pedido que não está `PENDING_PAYMENT`, ou com `expiresAt` vencido: `409 ORDER_NOT_PAYABLE`.
- Já existe cobrança `PENDING` para o pedido: `200` com ela, **sem** chamar o Mercado Pago.
- Senão, cria o pagamento Pix no Mercado Pago e grava a cobrança: `201`. O Pix vale **31 minutos a partir da criação** (`date_of_expiration`): o Mercado Pago exige no mínimo 30 minutos, mais 1 de folga, e a reserva do pedido é menor que isso. O prazo para pagar continua sendo o `expiresAt` do pedido; um pagamento aprovado depois dele não paga o pedido e gera o alerta `PAID_AFTER_EXPIRY` (decisão do Pedro, Q13). Se a cobrança anterior terminou `REJECTED` ou `CANCELLED` e o pedido ainda pode ser pago, é criada uma nova tentativa.
- Pix desligado, Mercado Pago fora do ar, tempo esgotado ou resposta fora do formato esperado: `503 PIX_UNAVAILABLE`. O pedido e a reserva não mudam.

Garantias: no máximo **uma** cobrança `PENDING` por pedido (índice único parcial no banco). Duas chamadas simultâneas terminam com uma cobrança só, e as duas respostas trazem a mesma cobrança. A chave de idempotência enviada ao Mercado Pago (`X-Idempotency-Key`) é determinística por pedido e tentativa.

### `GET /api/orders/:id/pix` — consulta a cobrança

Sem corpo. Devolve a cobrança **mais recente** do pedido e o status atual do pedido. A página chama a cada 5 segundos enquanto o pagamento está pendente.

- Pedido inexistente ou sem cobrança: `404`.
- **Verificação sob demanda**: se a cobrança está `PENDING` e o pedido `PENDING_PAYMENT`, a API consulta o pagamento no Mercado Pago e aplica a mesma transição do webhook antes de responder. No máximo **uma consulta a cada 20 segundos por pedido**, inclusive com chamadas simultâneas; nas demais a resposta vem só do banco.
- Falha do Mercado Pago na verificação não vira erro: a resposta é `200` com o estado atual do banco. Este endpoint nunca responde `503`.

### `POST /api/webhooks/mercadopago` — notificação do Mercado Pago

Chamada de servidor para servidor: CORS não se aplica. Segue o limite global de requisições.

Exemplo: `POST /api/webhooks/mercadopago?data.id=999999999&type=payment`

```http
x-signature: ts=1704908010,v1=<HMAC-SHA256 em hexadecimal, 64 caracteres>
x-request-id: bb56a2f1-6aae-46ac-982e-9dcd3581d08e
```

```json
{
  "id": 12345,
  "live_mode": false,
  "type": "payment",
  "date_created": "2026-10-28T10:04:58.396-03:00",
  "user_id": 44444,
  "api_version": "v1",
  "action": "payment.updated",
  "data": { "id": "999999999" }
}
```

Processamento, nesta ordem:

1. **Query** validada (`mercadoPagoWebhookQuerySchema`): `data.id` alfanumérico, até 64 caracteres. Inválida: `400`.
2. **Assinatura**: o header `x-signature` traz `ts` e `v1`. A API calcula HMAC-SHA256 com `MP_WEBHOOK_SECRET` sobre o texto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (`data.id` da query como recebido; para id alfanumérico também vale a forma em minúsculas, que a documentação antiga pedia. Ids de pagamento são numéricos) e compara com `v1` usando `timingSafeEqual`, conferindo o tamanho antes. O `ts` é em segundos (horário Unix) e precisa estar a no máximo **5 minutos** do relógio do servidor. Header ausente, repetido ou malformado, `x-request-id` ausente, assinatura diferente ou `ts` fora da janela: `401`, nada é gravado. Fonte do texto assinado e da unidade do `ts`: SDK oficial `mercadopago/sdk-nodejs` (`src/utils/webhook`), já que a página de webhooks não traz o algoritmo manual. Com o Pix desligado (variáveis ausentes), o webhook responde `503`.
3. **Corpo** validado (`mercadoPagoWebhookBodySchema`): só `type` e `data.id` são lidos; todo o resto, inclusive qualquer status, é descartado. Inválido, ou `data.id` do corpo diferente do da query: `400`.
4. `type` diferente de `payment`: `200`, ignorada. Pagamento que não é de nenhuma cobrança da loja: `200`, registrado e ignorado.
5. `x-request-id` já registrado em `payment_notifications`: `200`, sem reprocessar.
6. Consulta o pagamento no Mercado Pago (fora da transação) e, numa transação, aplica a transição e registra o `x-request-id`. Se a consulta ou a transação falhar: `500`, nada é registrado, e o reenvio do Mercado Pago é processado normalmente.

Efeito da transição, pelo status vindo da consulta ao Mercado Pago:

| Situação                                                                                                                   | Pedido                   | Estoque                           | Cobrança                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- | ------------------------------------------------------- |
| `approved`, referência = pedido, valor = `totalCents`, moeda `BRL`, pedido `PENDING_PAYMENT`, `date_approved <= expiresAt` | vira `PAID` (uma vez só) | `reserved -= qtd`, `stock -= qtd` | `APPROVED`                                              |
| `approved` com pedido já `EXPIRED` ou `CANCELED`                                                                           | não muda                 | não muda                          | `APPROVED`, alerta `PAID_AFTER_EXPIRY` (estorno manual) |
| `approved`, pedido ainda `PENDING_PAYMENT`, `date_approved > expiresAt`                                                    | não muda                 | não muda                          | `APPROVED`, alerta `PAID_AFTER_EXPIRY` (estorno manual) |
| `approved` com valor, moeda ou referência divergente                                                                       | não muda                 | não muda                          | alerta `AMOUNT_MISMATCH`                                |
| `rejected`, `cancelled`, `refunded`                                                                                        | não muda                 | não muda                          | status atualizado                                       |
| status desconhecido                                                                                                        | não muda                 | não muda                          | não muda (só log)                                       |

Mapeamento: `pending`, `in_process` e `authorized` → `PENDING`; `approved` → `APPROVED`; `rejected` → `REJECTED`; `cancelled` → `CANCELLED`; `refunded` → `REFUNDED`; qualquer outro (`charged_back`, `in_mediation`...) é desconhecido. Uma cobrança nunca volta para `PENDING`.

Reprocessar um pagamento já aprovado não faz nada. A transação trava o pedido e depois as variações, na mesma ordem do job de expiração e do painel, então webhook e expiração simultâneos terminam com o pedido `PAID` ou `EXPIRED`, nunca os dois. Os alertas ficam só no banco nesta versão.
