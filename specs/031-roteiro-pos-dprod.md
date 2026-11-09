# spec-031 — Roteiro de homologação depois do d-prod da 021

- Papel: docs — ver docs/agents/roles/
- Agente sugerido: Faísca (Claude Code)
- Depende de: spec-022 (roteiro atual)
- Pode rodar em paralelo com: spec-030 (que não toca `docs/homologacao-local.md`)
- Branch: `spec-031-roteiro-pos-dprod`

## Objetivo

`docs/homologacao-local.md` passa a refletir o que o d-prod da spec-021 (2026-11-08) e a re-homologação da 022 (2026-11-09) mostraram: o dev domain do ngrok gratuito, o limite do `read -rsp` fora de um terminal, o Pix de R$ 1,00 em produção, a seção 3.2 revalidada com `APP_USR-` e o webhook real.

## Contexto

- Decisões do Pedro (2026-11-09): nota "Triagem d-prod 021" e nota "Grilling Roteiro pós d-prod" (2 recomendações aceitas sem ajuste). Fatos na nota "Recon 030 031", levantados pela Formiga em fb5ccf5.
- O dev domain do ngrok gratuito do Pedro termina em `.ngrok-free.dev`. O roteiro usa `.ngrok-free.app` como padrão em `:15`, `:71`, `:78`, `:80`, `:92`, `:144`, `:165` e `:368`.
- O passo que troca credenciais usa `read -rsp` (`:65`). Pelo prefixo `!` do Claude Code não há TTY e a entrada sem eco não funciona, então esse passo tem que rodar num terminal do Pedro.
- O Pix do MP de produção aceitou R$ 1,00 em 2026-11-08. O roteiro já usa esse valor (`:5`, `:20`, `:344-362`, `:377`, `:381`, `:408`).
- A seção 3.2 tem o aviso "Não revalidado com `APP_USR-`" (`:125`). Em 2026-11-09, no sandbox com `APP_USR-`, a seção foi revalidada: `test@testuser.com` aceito, `APRO` aprova, `Ana Teste` fica pendente e o comprador de teste é dispensável.
- Webhook real (`:138-150`, `:199-205`, `:377-382` hoje não falam disso): a query traz `data.external_reference` além de `data.id` e `type=order`; o MP mandou 2 notificações para o mesmo pagamento (criação e pagamento), as duas com 200 e sem efeito duplicado; ids de produção no formato `ORD01...` e `PAY01...`.
- Estorno parcial real de R$ 0,50: pedido segue `PAID`, alerta `PAYMENT_REVERSED`, estoque intacto. O roteiro não tem passo de estorno parcial, só o estorno manual em `:234`.

## Escopo

1. `.ngrok-free.dev` vira o padrão em todas as linhas citadas, com `.ngrok-free.app` mencionado como variação possível do dev domain.
2. Junto de `:65`, aviso de que o `read -rsp` roda num terminal do Pedro, não pelo prefixo `!` do Claude Code (sem TTY).
3. Perto de `:344-362`, registro de que o Pix do MP de produção aceitou R$ 1,00 em 2026-11-08 (Q2). As outras menções a R$ 1,00 ficam como estão.
4. Seção 3.2: sai o aviso de `:125` e entra o registro da revalidação de 2026-11-09 com os quatro fatos do Contexto.
5. Fatos do webhook real nos trechos `:138-150` e `:377-382`: `data.external_reference` na query, 2 notificações por pagamento sem efeito duplicado, formato dos ids `ORD01...`/`PAY01...`.
6. Em `:234`, uma linha com o resultado esperado de um estorno parcial (pedido `PAID`, alerta `PAYMENT_REVERSED`, estoque intacto), citando a prova de 2026-11-08. Sem passo novo (Q1).

## Arquivos permitidos

- `docs/homologacao-local.md`
- `specs/031-roteiro-pos-dprod.md`

## Fora do escopo

- Qualquer arquivo de código, teste, `docs/api/**` e `docs/agents/scorecard.md` (a linha 029 entra pela spec-030).
- Passo novo de estorno parcial no roteiro.
- Rodar o roteiro, usar credenciais, `.env` real ou painéis (Mercado Pago, ngrok, Render, Supabase), que são do Pedro.

## Critérios de aceite

- [ ] Nenhuma ocorrência de `ngrok-free.app` como padrão; a variação aparece só onde o item 1 explica.
- [ ] Os itens 2 a 6 estão no texto, com as datas 2026-11-08 e 2026-11-09 onde cabem.
- [ ] O aviso "Não revalidado com `APP_USR-`" não existe mais.
- [ ] `git diff main --stat` só mostra os arquivos permitidos.
- [ ] Texto novo e corpo do PR passaram pelo humanizer.
- [ ] `npm run format:check` verde; CI completo verde.

## Notas para o revisor

- Revisão da Lente.
- Conferir que os fatos batem com o Contexto, sem afirmação que a prova real não sustenta.
- Sem deploy, sem smoke test.
