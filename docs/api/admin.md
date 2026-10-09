# API do painel administrativo

Contrato dos endpoints `/api/admin/**`. Decisões de autenticação em [ADR 0002](../adr/0002-autenticacao-admin.md).
Schemas e DTOs citados aqui estão em [`packages/shared/src/admin.ts`](../../packages/shared/src/admin.ts).

## Regras gerais

### Sessão e cookie

- O login cria uma linha em `admin_sessions` com o **hash SHA-256** (hex) de um token aleatório de 32 bytes. O token puro só existe no cookie.
- Cookie `otilc_admin`: `HttpOnly`, `SameSite=Strict`, `Secure` em produção, `Path=/`, `Max-Age=28800` (8 horas). A sessão no banco expira no mesmo instante (`expires_at`).
- Toda rota, exceto `POST /api/admin/session`, exige sessão válida: cookie presente, hash encontrado, `expires_at` no futuro e usuário `active`. Caso contrário: `401`.
- O navegador fala com a API pela **origem da loja**: o Next.js reescreve `/api/admin/:path*` para `${API_URL}/api/admin/:path*`. O CORS da API continua fechado.

### CSRF

- `SameSite=Strict` no cookie, **e**
- requisições `POST`, `PATCH`, `PUT` e `DELETE` em `/api/admin/**` cujo header `Origin` seja diferente de `WEB_ORIGIN` (ou esteja ausente) recebem `403` antes de qualquer outra verificação, inclusive o login.

### Papéis

Cada endpoint exige uma ação (`AdminAction`); `canRole(role, action)` decide. Papel sem permissão: `403`.

| Ação                 | OWNER | STAFF |
| -------------------- | :---: | :---: |
| `product:read`       |  sim  |  sim  |
| `product:create`     |  sim  |  não  |
| `product:update`     |  sim  |  não  |
| `variant:create`     |  sim  |  não  |
| `stock:update`       |  sim  |  sim  |
| `order:read`         |  sim  |  sim  |
| `order:updateStatus` |  sim  |  sim  |

STAFF não edita **nenhum** campo de produto (nem preço, nem nome, nem status) e não cria variação. "Papel mínimo" abaixo: `STAFF` = qualquer admin logado; `OWNER` = só o dono.

### Erros

Formato padrão do NestJS. Erro de validação (Zod, via `ZodValidationPipe`) traz a lista de campos:

```json
{
  "statusCode": 400,
  "message": "Dados inválidos.",
  "errors": [{ "field": "priceCents", "message": "Number must be greater than 0" }]
}
```

```json
{
  "statusCode": 409,
  "message": "Transição de status inválida: SHIPPED → PAID.",
  "error": "Conflict"
}
```

Comuns a todas as rotas autenticadas: `401` sem sessão válida, `403` por papel ou `Origin`, `429` por limite de requisições. IDs na rota são UUID; ID malformado responde `400`, ID inexistente `404`. Campos desconhecidos no corpo são descartados.

## Endpoints

| Método   | Rota                               | Papel mínimo | Ação                 | Corpo / query                  | Sucesso                                  | Erros                        |
| -------- | ---------------------------------- | ------------ | -------------------- | ------------------------------ | ---------------------------------------- | ---------------------------- |
| `POST`   | `/api/admin/session`               | público      | —                    | `adminLoginSchema`             | `200` `AdminUserDto` + cookie            | 400, 401, 403, 429           |
| `DELETE` | `/api/admin/session`               | STAFF        | —                    | —                              | `204` + cookie limpo                     | 401, 403                     |
| `GET`    | `/api/admin/me`                    | STAFF        | —                    | —                              | `200` `AdminUserDto`                     | 401                          |
| `GET`    | `/api/admin/products`              | STAFF        | `product:read`       | —                              | `200` `AdminProductDto[]`                | 401, 403                     |
| `GET`    | `/api/admin/products/:id`          | STAFF        | `product:read`       | —                              | `200` `AdminProductDto`                  | 400, 401, 403, 404           |
| `POST`   | `/api/admin/products`              | OWNER        | `product:create`     | `adminProductInputSchema`      | `201` `AdminProductDto`                  | 400, 401, 403, 409, 422      |
| `PATCH`  | `/api/admin/products/:id`          | OWNER        | `product:update`     | `adminProductPatchSchema`      | `200` `AdminProductDto`                  | 400, 401, 403, 404, 409, 422 |
| `POST`   | `/api/admin/products/:id/variants` | OWNER        | `variant:create`     | `adminVariantInputSchema`      | `201` `AdminVariantDto`                  | 400, 401, 403, 404, 409      |
| `PUT`    | `/api/admin/variants/:id/stock`    | STAFF        | `stock:update`       | `adminStockUpdateSchema`       | `200` `AdminVariantDto`                  | 400, 401, 403, 404, 409      |
| `GET`    | `/api/admin/orders`                | STAFF        | `order:read`         | query `adminOrderQuerySchema`  | `200` `Paginated<AdminOrderListItemDto>` | 400, 401, 403                |
| `GET`    | `/api/admin/orders/:id`            | STAFF        | `order:read`         | —                              | `200` `AdminOrderDetailDto`              | 400, 401, 403, 404           |
| `PATCH`  | `/api/admin/orders/:id/status`     | STAFF        | `order:updateStatus` | `adminOrderStatusUpdateSchema` | `200` `AdminOrderDetailDto`              | 400, 401, 403, 404, 409      |

## Detalhes por endpoint

### `POST /api/admin/session` — login

Público, mas sujeito ao CSRF por `Origin`. Limite: **5 tentativas por minuto por IP** (`429`).
O e-mail é normalizado pelo schema (`trim` + minúsculas). E-mail inexistente, senha errada e usuário inativo devolvem o **mesmo** `401` com a mesma mensagem.

```json
{ "email": "dono@example.com", "password": "teste-nao-e-uma-senha-real" }
```

`200`, com `Set-Cookie: otilc_admin=<token>; Path=/; Max-Age=28800; HttpOnly; SameSite=Strict` (+ `Secure` em produção):

```json
{ "id": "6f1c…", "email": "dono@example.com", "name": "Dono", "role": "OWNER" }
```

`401`: `{ "statusCode": 401, "message": "E-mail ou senha inválidos.", "error": "Unauthorized" }`

### `DELETE /api/admin/session` — logout

Apaga a sessão do banco e responde `204` com o cookie expirado (`Max-Age=0`, mesmos atributos, inclusive `Path=/`). Revogação é imediata.

### `GET /api/admin/me`

Devolve o `AdminUserDto` da sessão (mesmo formato do login). Nunca inclui `password_hash` nem `token_hash`.

### `GET /api/admin/products`

Todos os produtos, inclusive `DRAFT`, `RESERVED` e `SOLD_OUT`, do mais novo para o mais antigo. Cada item é um `AdminProductDto`.

### `GET /api/admin/products/:id`

```json
{
  "id": "0b3e…",
  "slug": "camiseta-veja-alem",
  "name": "Camiseta Veja Além",
  "brand": "OTILC",
  "description": "Algodão 100%.",
  "note": null,
  "priceCents": 12990,
  "condition": null,
  "status": "ACTIVE",
  "featured": true,
  "category": { "slug": "camisetas", "name": "Camisetas" },
  "images": [{ "url": "https://…/frente.jpg", "alt": "Camiseta preta, frente" }],
  "variants": [
    { "id": "9a2d…", "sku": "CAM-VA-P", "size": "P", "color": "Preto", "stock": 5, "reserved": 1 }
  ],
  "createdAt": "2026-10-08T12:00:00.000Z",
  "updatedAt": "2026-10-08T12:00:00.000Z"
}
```

### `POST /api/admin/products` — só OWNER

```json
{
  "slug": "camiseta-veja-alem",
  "name": "Camiseta Veja Além",
  "brand": "OTILC",
  "description": "Algodão 100%.",
  "priceCents": 12990,
  "condition": null,
  "status": "DRAFT",
  "featured": false,
  "categorySlug": "camisetas"
}
```

`201` com o `AdminProductDto` criado (sem variações). Erros: `409` slug já usado; `422` `categorySlug` inexistente.

### `PATCH /api/admin/products/:id` — só OWNER

Qualquer subconjunto **não vazio** dos campos do cadastro, com as mesmas regras (corpo vazio ou só com campos desconhecidos é `400`). Atualiza `updatedAt`.

```json
{ "priceCents": 9990, "featured": true }
```

`200` com o `AdminProductDto` atualizado. Erros: `404`; `409` slug já usado; `422` categoria inexistente.

### `POST /api/admin/products/:id/variants` — só OWNER

```json
{ "sku": "CAM-VA-M", "size": "M", "color": "Preto", "stock": 3 }
```

`201`:

```json
{ "id": "c41f…", "sku": "CAM-VA-M", "size": "M", "color": "Preto", "stock": 3, "reserved": 0 }
```

Erros: `404` produto inexistente; `409` SKU já usado ou mesma combinação tamanho/cor no produto.

### `PUT /api/admin/variants/:id/stock`

Define o **estoque total** (não é incremento).

```json
{ "stock": 2 }
```

`200` com o `AdminVariantDto` atualizado. `409` se `stock` ficar abaixo de `reserved` (unidades presas em pedidos aguardando pagamento):

```json
{
  "statusCode": 409,
  "message": "O estoque não pode ficar abaixo das 3 unidades reservadas.",
  "error": "Conflict"
}
```

A verificação deve ser feita no próprio `UPDATE` (`WHERE reserved <= novo estoque`), não só lendo antes, para não competir com uma reserva simultânea. O `CHECK variants_reserved_range` do banco é a última barreira.

### `GET /api/admin/orders`

Query: `status` (opcional, um de `PENDING_PAYMENT`, `PAID`, `CANCELED`, `EXPIRED`, `SHIPPED`), `pagina` (padrão 1, de 1 a 500), `porPagina` (padrão 20, de 1 a 100). Do mais novo para o mais antigo.

`GET /api/admin/orders?status=PAID&pagina=1`:

```json
{
  "items": [
    {
      "id": "e7a0…",
      "number": 42,
      "status": "PAID",
      "customerName": "Ana Souza",
      "totalCents": 25980,
      "itemCount": 2,
      "expiresAt": "2026-10-08T12:30:00.000Z",
      "createdAt": "2026-10-08T12:00:00.000Z"
    }
  ],
  "page": 1,
  "perPage": 20,
  "total": 1,
  "totalPages": 1
}
```

### `GET /api/admin/orders/:id`

```json
{
  "id": "e7a0…",
  "number": 42,
  "status": "PAID",
  "customerName": "Ana Souza",
  "customerEmail": "ana@example.com",
  "customerPhone": "+5585999990000",
  "totalCents": 25980,
  "expiresAt": "2026-10-08T12:30:00.000Z",
  "createdAt": "2026-10-08T12:00:00.000Z",
  "items": [
    {
      "variantId": "9a2d…",
      "sku": "CAM-VA-P",
      "productName": "Camiseta Veja Além",
      "size": "P",
      "unitPriceCents": 12990,
      "quantity": 2
    }
  ]
}
```

### `PATCH /api/admin/orders/:id/status`

```json
{ "status": "SHIPPED" }
```

`200` com o `AdminOrderDetailDto` atualizado. Transições permitidas (`canTransitionOrder`); qualquer outra é `409`:

| De                | Para       | Efeito no estoque da variação                            | Efeito no pagamento                      |
| ----------------- | ---------- | -------------------------------------------------------- | ---------------------------------------- |
| `PENDING_PAYMENT` | `PAID`     | `reserved -= qtd` e `stock -= qtd` (a unidade é vendida) | nenhum (só registra o status)            |
| `PENDING_PAYMENT` | `CANCELED` | `reserved -= qtd` (volta a ficar disponível)             | nenhum (não houve pagamento)             |
| `PAID`            | `SHIPPED`  | nenhum                                                   | nenhum                                   |
| `PAID`            | `CANCELED` | `stock += qtd` (a peça volta ao estoque)                 | **não estorna**: o estorno é feito à mão |

`PAID → CANCELED` devolve a peça ao estoque, mas **não** devolve o dinheiro ao cliente. Enquanto não existir integração de pagamento, o estorno é manual, feito pelo dono fora da loja.

`EXPIRED` só é aplicado pelo job de expiração, nunca pelo painel. A mudança de status e o ajuste de estoque acontecem na mesma transação, com `UPDATE … WHERE status = <de>`: se o job ou outro admin mudou o pedido no meio, a resposta é `409` e nada é alterado.
