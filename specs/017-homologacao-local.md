# spec-017 — Homologação local de ponta a ponta com o Mercado Pago sandbox

- Papel: `docs` (Faísca) — ver docs/agents/roles/
- Agente sugerido: Faísca (roteiro). Revisão: Lente; segunda revisão pela Forja (pagamento), conferindo cada passo e cada resultado esperado contra o código. O Pedro lê o diff inteiro e executa o roteiro.
- Depende de: spec-016 (mergeada em a9c40fe)
- Pode rodar em paralelo com: qualquer spec que não toque em `docs/homologacao-local.md`, `docs/deploy.md` ou `README.md`
- Branch: `spec-017-homologacao`

## Objetivo

O repositório traz um roteiro manual (`docs/homologacao-local.md`) que o Pedro segue sozinho, do zero, para provar na própria máquina que: com loja, API e Postgres locais, um pedido feito pela loja gera um Pix no Mercado Pago **sandbox**, o webhook volta por um túnel até a API local, o pedido muda de status, e expiração/cancelamento do Pix e conciliação funcionam. Cada passo tem o comando ou a ação e o resultado esperado.

## Contexto

- Decisões do Pedro: nota "Grilling Homologação" (fichário "Fluxo OTILC"), ok para as recomendações 1 a 13 e 15. Fatos do código: nota "Recon Homologação".
- A loja **não** vai ao ar nesta spec. Nada de Render, Vercel, Supabase ou produção.
- **Regras de segredos.** Credenciais do MP sandbox, segredo do webhook, conta do ngrok e a URL do túnel no painel do MP são do Pedro. Nenhum agente lê, cria ou edita `.env` real (há bloqueio por permissão). O roteiro diz ao Pedro **onde** colocar cada valor (`apps/api/.env`, `apps/web/.env.local`, painel do MP) com placeholders óbvios; nunca um valor real.
- Fatos que o roteiro precisa respeitar (detalhes e arquivo:linha na nota "Recon Homologação"):
  - Não há mock do MP em runtime. Sem `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `MP_NOTIFICATION_URL` o Pix fica desligado (503, "Pix indisponível"). Sandbox = credencial `TEST-` contra `api.mercadopago.com`.
  - A API local roda com `NODE_ENV` diferente de `production` (production exige CA do banco e `WEB_ORIGIN` https).
  - `MP_NOTIFICATION_URL` precisa ser https pública: túnel só para a API; a loja fica em `http://localhost:3000` (CORS e cookie do admin funcionam sem mudança).
  - Webhook: `POST /api/webhooks/mercadopago`, assinatura HMAC com tolerância de ±5 min (relógio do WSL precisa estar certo), deduplicação por `x-request-id` em `payment_notifications`.
  - Tempos: `ORDER_HOLD_MINUTES` mínimo 5; job de expiração a cada 60 s (cancela no MP o Pix PENDING com `PUT cancelled`); `PAYMENT_RECONCILIATION_INTERVAL_MS` mínimo 30000, pega PENDING com mais de 2 min; o Pix vale 31 min no MP.
  - O painel admin não mostra pagamento nem alertas: o Pedro vê isso por consultas `psql` no Postgres do `docker compose` e pelo log da API.
  - 1º admin local: `npm run admin:create -w @otilc/api` (interativo). `db:seed` não cria admin.
  - `scripts/smoke.sh http://localhost:3333 http://localhost:3000` funciona contra o local e só faz GET.
- Nunca validado contra o MP real (é isto que a homologação descobre): formato real de `x-signature`/`x-request-id`/`data.id`, corpo do webhook, campos de `GET`/`POST /v1/payments`, `date_of_expiration` com `+00:00`, `PUT cancelled`, e-mail do pagador no sandbox.

## Emenda: bloco final com Pix real (decisão do Pedro, 2026-10-28)

A documentação oficial do MP não traz método para aprovar um Pix de teste em `/v1/payments`. O Pedro autorizou explicitamente ampliar a homologação:

- O sandbox cobre o que permite: Pix gerado, expiração + `PUT cancelled`, assinatura inválida (401), admin e `SHIPPED`.
- O roteiro termina com um **bloco final** de Pix real de valor mínimo (~R$ 1), com aviso destacado no topo: credenciais de **produção da conta do próprio Pedro** no Mercado Pago (não a da conta do cliente), só no `apps/api/.env` local dele, API em localhost via túnel, sem deploy. Cobre os casos d (aprovado → `PAID` + estoque), f (webhook perdido → conciliação) e g (pago após expirar → alerta), se der.
- Depois do bloco, o roteiro volta às credenciais de teste, e o último passo revoga ou renova as credenciais de produção no painel do MP.
- Os agentes continuam sem tocar em credencial ou `.env` real. A execução do bloco é só do Pedro.

Esta emenda substitui, para os casos d, f e g, o fallback "verificar via conciliação/consulta" da seção 3 de "Como fazer".

## Arquivos permitidos

- `docs/homologacao-local.md` (novo)
- `README.md` — só um link curto para o roteiro na seção "Como rodar"
- `docs/deploy.md` — só o trecho da linha 44 (ressalva aberta da 016: deixar claro que o `.crt` baixado é temporário, usado na criação do admin do passo 6 e apagado depois). Nada mais nesse arquivo.

## Fora do escopo

- Qualquer mudança de código, teste, configuração, `packages/shared`, banco, migração ou `docs/api/**`.
- Script novo (o roteiro é manual; `smoke.sh` existente é reaproveitado sem mudança).
- Mostrar pagamento ou alertas no painel admin (spec-018).
- Baixar os mínimos de `ORDER_HOLD_MINUTES` ou do intervalo da conciliação.
- Estorno e contestação (dependem de recursos do sandbox).
- Corrigir bug que a homologação encontrar: cada falha vira spec de correção própria (Forja), e o passo é reexecutado depois.
- Docker compose completo (spec curta depois da 018).

## Como fazer (Faísca)

Escreva `docs/homologacao-local.md` em português, para o Pedro seguir sozinho no WSL. Estrutura mínima:

1. **Visão geral**: o que será provado, diagrama simples (navegador → loja → API ← túnel ← MP), tempo estimado, aviso de que nada aqui é produção.
2. **Passo 0 — pré-requisitos**:
   - Relógio do WSL: conferir `date -u` contra a hora real e como ressincronizar (ex.: `sudo hwclock -s`); por quê (assinatura ±5 min → 401).
   - **Instalação do ngrok no WSL** (o Pedro ainda não tem ngrok nem cloudflared): instalação pelo método oficial para Linux, criação da conta, `ngrok config add-authtoken` (token do Pedro, nunca no repo), reserva do **domínio estático gratuito** no painel do ngrok e o comando para subir o túnel com esse domínio apontando para `localhost:3333`. Confira na documentação oficial do ngrok e cite os links.
   - Alternativa: cloudflared quick tunnel (instalação no WSL, comando, aviso de que a URL muda a cada subida e exige atualizar `.env` e painel do MP). Cite a doc oficial.
   - Projeto rodando como no README (`docker compose up -d db`, `.env` a partir dos `.env.example`, migrate, seed).
3. **Mercado Pago sandbox**: criar a aplicação/credenciais de teste e os usuários de teste (vendedor e comprador), onde achar o Access Token `TEST-`, configurar Webhooks no painel (modo de testes, evento "Pagamentos", URL `https://<domínio-do-túnel>/api/webhooks/mercadopago`) e de onde vem a assinatura secreta. Pesquise na documentação oficial do MP (context7/web) e cite os links. **Como aprovar um Pix de teste** e se o e-mail do pagador precisa ser o do comprador de teste: documente o método oficial; se o sandbox não permitir aprovar Pix, marque os passos dependentes como "verificar via conciliação/consulta" e avise a Bússola no PR.
4. **Onde colocar cada valor**: tabela variável → arquivo (`apps/api/.env` ou `apps/web/.env.local`) ou painel → de onde vem → exemplo com placeholder. Incluir `ORDER_HOLD_MINUTES=5` e `PAYMENT_RECONCILIATION_INTERVAL_MS=30000` para o teste, e reiniciar a API depois de mudar o `.env`.
5. **Casos de teste**, numerados, cada um com ação, resultado esperado (tela, log da API e consulta `psql` quando couber) e linha OK/FALHA para o Pedro marcar:
   - a) `scripts/smoke.sh` contra localhost;
   - b) criar o 1º admin e logar em `/admin/login`;
   - c) catálogo → carrinho → pedido → Pix gerado (QR e copia-e-cola), pedido `PENDING_PAYMENT`, estoque reservado;
   - d) Pix aprovado no sandbox → webhook chega pelo túnel (log do ngrok e da API) → pedido `PAID`, estoque baixado; conferir duplicatas (`payment_notifications`) e registrar se disparou a `notification_url` do pagamento, o webhook do painel ou os dois;
   - e) pedido não pago expira (~6 min) → pedido cancelado e Pix cancelado no MP (`PUT cancelled`), conferido no log e no painel/consulta do MP;
   - f) webhook perdido: derrubar o túnel, aprovar o Pix, esperar a conciliação (~3 min) → pedido `PAID` sem webhook;
   - g) Pix pago depois da expiração → alerta `PAID_AFTER_EXPIRY` em `payment_alerts` (se o sandbox permitir);
   - h) webhook com assinatura inválida (ex.: `curl` com `x-signature` inventado) → 401;
   - i) admin muda o pedido pago para `SHIPPED`.
6. **Consultas `psql` prontas** (só leitura, no Postgres local do `docker compose`) para `orders`, `payments`, `payment_alerts` e `payment_notifications`. Confira nomes de tabelas e colunas em `apps/api/src/db/schema.ts`.
7. **Problemas comuns**: 401 "Assinatura inválida" (relógio, segredo errado), 503 "Pix indisponível" (variável faltando), URL do túnel mudou, limite de login do admin (5/min), pedido expirado não pode ser reaproveitado (criar outro).
8. **Tabela de resultado** para o Pedro preencher e mandar à Bússola.

Também: link curto no `README.md` ("Como rodar" → homologação local) e a correção de 1-2 linhas em `docs/deploy.md:44`.

Dados de exemplo só com domínios reservados (`example.com`, `*.test`) e placeholders óbvios (`TEST-xxxx`, `<seu-dominio>.ngrok-free.app`). Nenhum token, segredo ou domínio real.

## Critérios de aceite

- [ ] `docs/homologacao-local.md` existe com as seções 1 a 8 acima; cada caso de teste tem ação, resultado esperado e campo OK/FALHA.
- [ ] O passo 0 cobre a instalação do ngrok no WSL, a conta, o authtoken e o domínio estático gratuito, e a alternativa cloudflared, com links da documentação oficial.
- [ ] A seção do MP cita a documentação oficial para credenciais de teste, usuários de teste, configuração de webhook e aprovação de Pix de teste.
- [ ] Toda variável citada existe em `apps/api/.env.example` ou `apps/web/.env.example`, com o mesmo nome; todo caminho, comando, status, tabela e coluna citados existem no código (conferido pela Forja na 2ª revisão).
- [ ] Nenhum segredo, token ou domínio real; nenhum passo pede para colocar segredo em arquivo versionado.
- [ ] `README.md` tem o link para o roteiro; `docs/deploy.md` só mudou o trecho da linha 44.
- [ ] O diff só toca os arquivos permitidos.
- [ ] `npm run format:check && npm run typecheck && npm test` verdes. CI completo verde.

## Notas para o revisor

- Conferir cada resultado esperado contra o código (status, mensagens, rotas, tempos), principalmente os de pagamento: um roteiro que promete um comportamento que o código não tem faz o Pedro achar bug onde não há.
- Conferir que nenhum passo manda rodar a API com `NODE_ENV=production`, nem comando contra banco que não seja o local do `docker compose`.
- Os links do ngrok e do MP devem ser da documentação oficial.
- A execução real contra o MP é do Pedro, depois do merge; o PR não depende dela.
