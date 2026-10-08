# spec-001 — Contratos do catálogo (OpenAPI + schema do banco)

- Agente sugerido: Claude Code (você revisa com muita atenção)
- Depende de: spec-000
- Pode rodar em paralelo com: **nada** (é a fronteira que libera o paralelismo)
- Branch: `spec-001-contratos`

## Objetivo

Definir o contrato da API de catálogo e o schema do banco. Depois do merge desta spec, back, front e dados podem trabalhar em paralelo.

## Contexto

Domínio de streetwear. Um produto tem várias variantes (tamanho + cor), cada uma com SKU e estoque próprios, e várias imagens.

Modelo esperado (ajuste nomes se precisar, mas mantenha o conceito):

- `Category`: id, slug (único), name
- `Product`: id, slug (único), name, description, priceCents (int), active (bool), categoryId, createdAt, updatedAt
- `ProductVariant`: id, productId, size (`PP|P|M|G|GG|XG`), color, sku (único), stock (int ≥ 0)
- `ProductImage`: id, productId, url, alt, position (int)

Endpoints públicos (somente leitura):

- `GET /products?category=&size=&page=&pageSize=` — lista paginada, só produtos `active`
- `GET /products/{slug}` — detalhe com variantes e imagens; 404 se não existir ou estiver inativo
- `GET /categories` — lista de categorias

## Arquivos permitidos

- `packages/contracts/openapi.yaml`
- `packages/contracts/**` (script de geração de tipos e tipos gerados)
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/**`

## Fora do escopo

- Implementar controllers, services ou telas.
- Endpoints de escrita (admin) — virão em spec futura.

## Critérios de aceite

- [ ] `openapi.yaml` válido (OpenAPI 3.1), com schemas, exemplos e respostas de erro 400/404
- [ ] Paginação com `page` (≥1) e `pageSize` (1–50, padrão 12), resposta com `items`, `page`, `pageSize`, `total`
- [ ] Tipos TypeScript gerados a partir do OpenAPI e exportados por `packages/contracts`
- [ ] Migração Prisma criada e aplicável em banco limpo
- [ ] Índices em `slug` e `sku` (únicos) e em `Product.categoryId`

## Notas para o revisor

- Esta é a decisão mais cara de mudar depois. Leia o contrato inteiro antes de aprovar.
- Conferir que preço é inteiro em centavos e que estoque não aceita negativo.
