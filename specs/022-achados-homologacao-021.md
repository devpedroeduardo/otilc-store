# spec-022 — Achados da homologação local da spec-021: criação única do Pix e roteiro do sandbox

- Papel: `backend` + `frontend` + `docs`. Forja: back, PR e scorecard. Faísca: front, Playwright e docs. Ver docs/agents/roles/
- Agente sugerido: Forja e Faísca em paralelo, com a fronteira de arquivos abaixo. Fatos e vigia do CI: Formiga. Revisão: Lente. Como é pagamento, cada dev faz a segunda revisão da parte do outro, e o Pedro lê o diff inteiro.
- Depende de: spec-021 (mergeada em d75a019)
- Pode rodar em paralelo com: nada que toque em `apps/api/src/payments/**` ou `apps/web/src/components/pedido-pix.tsx`
- Branch: `spec-022-pix-criacao-unica`

## Objetivo

Cada pedido gera **um único** `POST /v1/orders` de criação do Pix, mesmo com duplo mount do StrictMode, duas abas ou cliques repetidos. No fluxo normal não sai 423 do MP nem aparece "Pix indisponível", nem por um instante. O roteiro `docs/homologacao-local.md` 3.x pode ser reproduzido com a credencial `APP_USR-` de um usuário de teste vendedor e documenta que o sandbox não entrega webhook real de order.

## Contexto

- Achados da homologação local da spec-021 (Pedro, 2026-10-30):
  1. A API de Orders recusa token `TEST-` com 401 invalid_credentials. O sandbox exige a credencial de produção (`APP_USR-`) de um usuário de teste vendedor, com aplicação e webhook próprios.
  2. A criação do Pix sai duplicada: 423 resource_locked (idempotency key locked) em 8 de 8 pedidos, e a tela mostra "Pix indisponível" por um instante antes do Pix aparecer.
  3. O sandbox não entrega webhook real de order. Só o "Simular notificação" do painel chega.
- Decisões: nota "Grilling Achados 021" (fichário "Fluxo OTILC"). O Pedro aceitou as recomendações 2 a 7 e 9 a 15. Nas perguntas 1 e 8 ele não lembra do que viu:
  - a raiz do achado 2 fica como **PROVÁVEL** (StrictMode, mais a falta de guarda no front e de trava no back). Quem prova são os testes que falham antes da correção e a re-homologação do Pedro;
  - toda a seção 3.2 do roteiro fica marcada "não revalidado com APP_USR-", sem inventar comportamento do sandbox.
- Fatos do código: nota "Recon Achados 021" (Formiga, main d75a019). Os pontos principais:
  - `apps/web/next.config.ts:8` liga o `reactStrictMode`;
  - em `pedido-pix.tsx:53-67`, start() e o efeito não têm guarda nem cleanup, e a última resposta a chegar decide a tela;
  - `pix.service.ts:57-97` não trava nada antes de chamar o MP (o FOR UPDATE só vem na gravação);
  - qualquer erro do provedor vira 503 PIX_UNAVAILABLE (`pix.service.ts:77-87`);
  - quem perde a corrida não cancela a order que criou (`pix.service.ts:124-136`).
    Se algum fato contradisser esta spec, pare e avise a Bússola.
- Achado 2 da spec-017 (500 no 1º POST de cada pedido, a 2ª tentativa passava): registrado como provável mesma raiz. Ele fecha na re-homologação do Pedro se não aparecer nenhum 5xx/423 no log.
- Garantias de estoque e pedidos (README, "Destaques técnicos"): nada pode regredir.

## Decisões de implementação

1. **Back (Forja)**: serializar a criação por pedido com `pg_advisory_xact_lock` usando uma chave derivada do id do pedido, via template `sql` do Drizzle (parametrizado).
   - A trava fica segurada durante a leitura da cobrança pendente, a chamada ao MP e a gravação. Quem chega depois espera e devolve `200` com a cobrança gravada pela primeira chamada.
   - O custo aceito é uma conexão presa por até o timeout do cliente (10 s).
   - Sem schema, sem migração e sem mudança de contrato.
   - O 423 não ganha tratamento próprio: se aparecer, continua 503 com log warn.
   - A lacuna da order órfã do perdedor deixa de existir com a trava. Não entra cancelamento novo.
2. **Front (Faísca)**: em `pedido-pix.tsx`, guarda com `useRef` de "criação em andamento" (sobrevive ao remount do StrictMode) e descarte de resposta velha, para que um resultado antigo nunca sobrescreva a tela.
   - O `reactStrictMode` continua `true`.
   - "Tentar de novo" e "Gerar novo Pix" continuam funcionando, cada um com um único POST por clique.
3. **Docs (Faísca)**: `docs/homologacao-local.md`:
   - **3.1**: passo a passo para criar o usuário de teste vendedor (e o comprador, se a 3.2 precisar), entrar no painel como o vendedor, criar a aplicação dele, usar a credencial de **produção** `APP_USR-` desse vendedor e configurar o webhook próprio da aplicação (URL e segredo). Sai a frase "o prefixo não importa". Entra "`TEST-` dá 401 invalid_credentials na API de Orders". A API não passa a validar o prefixo.
   - **3.2**: marcada "não revalidado com APP_USR-", com as regras atuais mantidas como registro da credencial antiga.
   - **3.3**: o sandbox não entrega webhook real de order. Só o "Simular notificação" chega, e ele serve para testar a rota e a assinatura.
   - **9.4**: esta é a primeira prova de webhook real (Pix real de ~R$ 1, feita pelo Pedro).
   - **Placeholders** de `homologacao-local.md:151` e `apps/api/.env.example:22`: texto que não pareça token, por exemplo `<access-token-APP_USR-do-vendedor-de-teste>`.
   - Texto em prosa simples (antecipa a spec do humanizer).

## Arquivos permitidos

Forja:

- `apps/api/src/payments/pix.service.ts` e `apps/api/src/payments/*.spec.ts` (incluindo um `pix.service.spec.ts` novo, se fizer sentido)
- `apps/api/test/payments.e2e-spec.ts` e helpers em `apps/api/test/**` que ele usa
- `docs/agents/scorecard.md`: linha 021, Uso/tokens "~8% da semana (0% → 8%)", em commit `docs(agents)` separado

Faísca:

- `apps/web/src/components/pedido-pix.tsx`
- `e2e/pedido-pix.spec.ts` e `e2e/support/**`
- `docs/homologacao-local.md`
- `apps/api/.env.example` (só o placeholder da linha do token)

As duas fronteiras não se cruzam: cada dev commita só os próprios caminhos (`git add <caminhos>`), na mesma worktree.

## Fora do escopo

- `packages/shared/**`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/**`, `docs/api/**`, `apps/web/next.config.ts`, `.github/workflows/**`.
- `specs/017-*.md` e outras specs mergeadas (registro histórico, não se edita).
- Tratamento novo para o 423, retry automático, cancelamento da order do perdedor, validação de prefixo do token.
- Credenciais, `.env` real e painéis do MP, Render e Supabase (só o Pedro mexe). O MP é sempre mockado. Produção não é tocada.
- Re-homologação no sandbox: o Pedro faz depois do merge.

## Critérios de aceite

- [ ] (e2e API) N `POST /api/orders/:id/pix` simultâneos, com a criação do mock lenta, chamam o provedor **1 vez**. Todos recebem o mesmo QR, um com 201 e os outros com 200. O teste **falha na main d75a019** (o PR diz como isso foi conferido).
- [ ] (e2e API) Pedidos diferentes não se bloqueiam: as criações simultâneas de 2 pedidos chamam o provedor 1 vez cada.
- [ ] (Playwright) No fluxo normal da página do pedido sai **1** POST /pix por pedido, e "Pix indisponível" não aparece em nenhum momento. O teste falha no código atual. Se o `test:e2e:web` sobe a loja em build de produção (sem StrictMode), o PR explica como o duplo mount foi coberto.
- [ ] (Playwright) Resposta velha não sobrescreve a tela: uma resposta de erro atrasada, depois de uma de sucesso, não troca o QR por erro.
- [ ] Testes existentes de payments, conciliação, alertas, admin-orders (incluindo concorrência), backoff, rls e o `compra.spec.ts` ("Pix indisponível" sem MP) passam sem enfraquecer nenhuma asserção.
- [ ] O roteiro 3.1/3.2/3.3/9.4, o placeholder da seção 4 e o `apps/api/.env.example` ficam como nas Decisões. Nenhum `TEST-` restante no roteiro diz que funciona com Orders.
- [ ] Scorecard: linha 021 em commit `docs(agents)` separado.
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e && npm run test:e2e:web` verdes.

## Notas para o revisor

- Pagamento: a trava fica segurada durante uma chamada HTTP externa. Confira que é `xact` (liberada no commit/rollback, inclusive em erro e timeout), que a chave não colide entre pedidos e que o pool não esgota no cenário do teste.
- Confira que o caminho do GET (consulta sob demanda) não passa pela trava.
- Front: a guarda não pode travar "Tentar de novo" depois de um erro real.
- Aceite final (pós-merge, Pedro): roteiro 3.1 a 3.3 com `APP_USR-` de teste em pelo menos 3 pedidos, sem 423 no log e sem flash na tela. Se passar, fecha também o achado 2 da spec-017.
