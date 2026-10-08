# spec-003 — Páginas do catálogo (web)

- Agente sugerido: Codex
- Depende de: spec-001
- Pode rodar em paralelo com: spec-002, spec-004
- Branch: `spec-003-web-catalogo`

## Objetivo

Páginas `/produtos` (grade com filtros) e `/produtos/[slug]` (detalhe) no Next.js, funcionando contra **mocks gerados do contrato**, prontas para apontar para a API real trocando só a URL base.

## Contexto

A API está sendo construída em paralelo por outro agente. Use os tipos de `packages/contracts` e um mock (ex.: MSW ou fixtures tipadas) baseado nos exemplos do `openapi.yaml`. A URL da API vem de `NEXT_PUBLIC_API_URL` (documente no `.env.example` do web).

Identidade visual: cores do logo da OTILC (placeholder por enquanto: fundo escuro, tipografia forte, estética streetwear). Mobile first.

## Arquivos permitidos

- `apps/web/app/produtos/**`
- `apps/web/components/catalog/**`
- `apps/web/lib/api/**`
- `apps/web/mocks/**`
- `apps/web/.env.example`
- `apps/web/**/*.test.tsx` relacionados às páginas acima

## Fora do escopo

- Alterar contrato, api ou banco.
- Carrinho, checkout, login.

## Critérios de aceite

- [ ] `/produtos` lista produtos com imagem, nome e preço formatado em BRL a partir de `priceCents`
- [ ] Filtros por categoria e tamanho refletem na URL (query string), compartilháveis
- [ ] Paginação funcional
- [ ] `/produtos/[slug]` mostra galeria, descrição, tamanhos disponíveis (variantes com estoque 0 aparecem desabilitadas)
- [ ] Página 404 amigável para produto inexistente
- [ ] Metadados de SEO (title, description, Open Graph) no detalhe
- [ ] Testes Vitest para formatação de preço, filtros e estados vazio/erro
- [ ] Sem `any`; client components só onde houver interação
- [ ] `pnpm lint && pnpm typecheck && pnpm test` verdes

## Notas para o revisor

- Conferir acessibilidade básica: `alt` nas imagens, foco visível, contraste.
- Conferir que nada chama a API diretamente fora de `lib/api`.
