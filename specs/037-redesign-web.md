# spec-037: redesign da loja e do painel

- Papel: frontend
- Agente sugerido: Claude Code
- Depende de: nenhuma
- Pode rodar em paralelo com: specs só de API
- Branch: `spec-037-redesign-web`

## Objetivo

A loja e o painel ganham um visual mais completo e com mais vida, mantendo a identidade da vitrine da pré-venda (preto, cromado, Archivo, Instrument Serif, Space Mono e o olho da marca). Nenhum contrato, regra de negócio ou endpoint muda.

## Contexto

O Pedro achou as telas paradas e simples demais. Problemas concretos encontrados antes da mudança:

- O topo da home ocupava metade da tela e deixava a outra metade vazia.
- O texto corrido herdava só os pesos 700 a 900 da Archivo, então tudo parecia negrito.
- O painel renderizava o cabeçalho e o rodapé da loja e, por cima, o próprio menu.
- Status apareciam crus (`PENDING_PAYMENT`, `ACTIVE`) e o detalhe do pedido era uma lista de parágrafos.

## O que muda

Loja:

- Rotas da loja vão para o grupo `app/(loja)/`, com cabeçalho e rodapé no layout do grupo. As URLs não mudam.
- Home: o olho vivo da marca no topo (detalhes abaixo), faixa corrida com números do drop calculados da API, grade com a primeira peça em destaque ocupando 2 colunas, card com número da peça e "Ver peça" no hover, seção "Como comprar" com os 3 passos reais da compra.
- Produto: trilha de navegação, galeria com miniaturas e zoom, condição explicada em palavras, garantias da compra e "Mais peças" da mesma categoria.
- Carrinho e pagamento: linha de etapas, estados vazios e de carregamento, Pix em duas colunas com barra de tempo.
- Rodapé completo e página 404 própria.

Painel:

- Layout próprio com barra lateral (vira barra de abas no celular), contadores de pedidos aguardando Pix e alertas abertos.
- Indicadores no topo de Produtos e Pedidos, filtros por status com contagem, status em português com cor.
- Detalhe do pedido em cartões (itens com total, andamento, cliente com links de e-mail e WhatsApp).
- Editor de produto em seções, com prévia do card ao vivo.
- Login em tela dividida.
- Os dados do modo mock ganharam mais exemplos com fotos do catálogo, para o desenvolvimento sem API.

Transições entre telas (View Transitions do React, skill `vercel-react-view-transitions`):

- A foto do card vira a foto grande da página do produto, e a foto de "Mais peças" vira a principal.
- Ao filtrar ou ordenar, os cards entram, saem e deslizam no lugar, sem pular para o topo.
- Páginas da loja entram subindo. No painel, só o conteúdo sobe na troca de aba.
- Peça removida do carrinho sai deslizando e a lista fecha o espaço.
- Cabeçalho da loja e barra lateral do painel ficam parados durante as transições.
- No Next 15.5 a API só existe com `experimental.viewTransition` e com o nome `unstable_ViewTransition`. Tudo passa por `components/view-transition.tsx`: sem a flag, ele vira um repasse e a página funciona sem animar. Navegador sem suporte também não anima.

O olho vivo no topo da home e a logo (`components/live-eye.tsx` + `.live-eye` em `globals.css`):

- A cena do lago (história da marca) saiu: o Pedro achou que não combinou com a proposta da marca.
- A logo ganhou um olho novo, em SVG: pálpebras e sobrancelha em tubo cromado, abertura escura e funda, e um globo de prata com a pupila preta envolta por um anel do mesmo tubo das pálpebras. Referência pedida pelo Pedro: o globo do Olho do Milênio (Yu-Gi-Oh), adaptado ao cromado prata e à forma amendoada da OTILC, sem o medalhão redondo, o dourado nem os riscos gravados. As letras TILC continuam as originais.
- O cromado do olho foi calibrado para o mesmo tom das letras (mediana de luminância ~126 contra 120 nas letras).
- No topo da home o olho é grande e vivo: o globo segue o mouse ou o dedo, a pupila anda um pouco mais que o globo (efeito de esfera girando), pisca sozinho a cada 3 a 7 s e ao clicar, e ao passar o mouse o globo fica azul e volta a prata. Sem ponteiro por 2,5 s, passeia devagar. Com `prefers-reduced-motion` fica parado.
- No cabeçalho e no rodapé a logo é o mesmo olho, pequeno, seguindo o mouse, ao lado das letras (`tilc.webp`).
- `logo.webp`, `logo-sm.webp`, `eye.webp`, `favicon-32.png` e `apple-touch-icon.png` são capturas desse SVG, então a logo parada e o olho animado são o mesmo desenho. O painel e as páginas com o olho parado (carrinho vazio, 404, login) usam essas imagens.

## Arquivos permitidos

- `apps/web/src/**`
- `apps/web/public/brand/**` (logo, olho e ícones gerados do SVG do olho, mais `tilc.webp`)
- `apps/web/next.config.ts` (só a flag `experimental.viewTransition`)
- `e2e/admin.spec.ts`, `e2e/compra.spec.ts` (só seletores que dependiam do markup antigo)
- `specs/037-redesign-web.md`

## Fora do escopo

- `packages/shared/**`, API, banco e `docs/api/**`.
- Dependência nova. Ícones são SVG inline em `components/icons.tsx`.

## Critérios de aceite

- [x] `npm run format:check && npm run typecheck && npm test` verdes
- [x] `npm run test:e2e:web` verde (10 de 10)
- [x] `npm run build -w @otilc/web` verde
- [x] Nenhuma tela com rolagem horizontal em 390 px de largura
- [x] `prefers-reduced-motion` deixa o olho vivo parado e desliga a faixa corrida e as transições
- [x] O olho vivo anda a 60 quadros por segundo no Chromium enquanto o mouse se mexe (mediana de 16,7 ms por quadro no trace)

## Notas para o revisor

- Mudanças nos E2E: o link "Ver carrinho →" perdeu a seta no texto, o detalhe do pedido mostra `Pedido #N` como título e o status em português num selo (`.order-status`). Nenhuma verificação foi removida.
- A seção "Variações e estoque" do editor não tem nome acessível de propósito: com nome, o `getByLabel('Estoque')` do E2E encontraria dois elementos.
- A flag `experimental.viewTransition` troca o React interno do Next pelo canal experimental. O build e os 10 E2E passaram com ela. Se aparecer qualquer problema em produção, desligar a flag tira só as animações. Na migração para o Next 16.2, a flag sai e o `<Link transitionTypes>` permite slides com direção (ir e voltar).
- Desempenho do olho: o cromado sai de filtros de luz do SVG, caros. Por isso o olho é uma pilha de camadas desenhadas uma vez e movidas só com `transform`. Duas armadilhas medidas no trace e evitadas: `filter: drop-shadow` do CSS em camada parada é refeito a cada quadro (a sombra fica dentro do SVG), e `backdrop-filter` no cabeçalho era refeito a cada movimento do olho da logo (o cabeçalho passou a fundo 94% opaco, sem desfoque).
- A tela de Pedidos faz 6 chamadas à listagem para mostrar as contagens por status. Para o volume da loja isso é barato; se crescer, vale um endpoint de resumo.
