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
- Home: pilha de fotos reais das peças em leque (o único movimento automático), faixa corrida com números do drop calculados da API, grade com a primeira peça em destaque ocupando 2 colunas, card com número da peça e "Ver peça" no hover, seção "Como comprar" com os 3 passos reais da compra.
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

A história da marca no topo da home (`components/lake-story.tsx` + `.story` em `globals.css`):

- Cena simbólica da história transcrita pelo José Clito, em prata e azul, sem desenhar o personagem: a luz do Otilc vai de pedra em pedra até o lago, uma gota cai do céu, ondas, um olho azul surge no reflexo, uma luz atravessa a água, o olho fica prateado, sobe até o lugar do olho da logo e vira a logo original (`logo.webp`), com reflexo no lago.
- Dura cerca de 7 s e toca na primeira visita. Depois (ou com `prefers-reduced-motion`) abre direto no quadro final, com o botão "Ver de novo".
- Toda a coreografia é CSS. O componente só escolhe entre tocar e mostrar o quadro final, e guarda em `localStorage` que a história já foi vista.
- A logo da marca continua sendo a original. Uma versão em SVG foi testada e descartada pelo Pedro.
- O olho cromado original (`eye.webp`) aparece parado no carrinho vazio, na 404 e no login.

## Arquivos permitidos

- `apps/web/src/**`
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
- [x] `prefers-reduced-motion` desliga leque, faixa corrida e transições

## Notas para o revisor

- Mudanças nos E2E: o link "Ver carrinho →" perdeu a seta no texto, o detalhe do pedido mostra `Pedido #N` como título e o status em português num selo (`.order-status`). Nenhuma verificação foi removida.
- A seção "Variações e estoque" do editor não tem nome acessível de propósito: com nome, o `getByLabel('Estoque')` do E2E encontraria dois elementos.
- A flag `experimental.viewTransition` troca o React interno do Next pelo canal experimental. O build e os 10 E2E passaram com ela. Se aparecer qualquer problema em produção, desligar a flag tira só as animações. Na migração para o Next 16.2, a flag sai e o `<Link transitionTypes>` permite slides com direção (ir e voltar).
- A tela de Pedidos faz 6 chamadas à listagem para mostrar as contagens por status. Para o volume da loja isso é barato; se crescer, vale um endpoint de resumo.
