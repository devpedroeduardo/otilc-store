# spec-034 — `permissions: contents: read` no topo dos workflows

- Papel: infra (CI) — ver docs/agents/roles/
- Agente sugerido: Forja (Claude Code)
- Depende de: spec-033 (jobs `e2e-web` e `compose` no CI)
- Pode rodar em paralelo com: nenhuma
- Branch: `spec-034-permissions-workflow`

## Objetivo

Todo workflow em `.github/workflows` declara `permissions: contents: read` no topo, e nenhum job tem bloco `permissions` próprio. Um job que um dia precisar de mais pede o escopo no próprio job, em spec que diga isso. O CI segue verde e os checks obrigatórios do ruleset `otilc-rules` mantêm os mesmos nomes.

## Contexto

- Decisões do Pedro (2026-11-09) na nota "Grilling permissions workflow" do fichário "Fluxo OTILC": as 8 recomendações aceitas como estão. Os fatos vêm da Formiga (origin/main 7730011, só leitura), e a Bússola conferiu alguns por `gh`, também só leitura.
- A ressalva saiu da 2ª revisão da Faísca na spec-033: `qualidade`, `integracao` e `build` não declaram `permissions` e herdam o padrão do repositório.
- O padrão do repositório já é `read` (`default_workflow_permissions: read`). O diff não muda o token de hoje: ele passa a regra do painel para o arquivo, onde é revisada em PR e vale para quem copiar o workflow. O PR descreve a mudança como hardening, sem tratá-la como correção de falha aberta.
- `security.yml` já tem `permissions: contents: read` no topo e nenhum bloco por job. Não muda.
- `ci.yml` não tem bloco no topo. `e2e-web` e `compose` têm `permissions: contents: read` no job. Um bloco no job substitui o do topo por inteiro, então esses dois blocos saem: se alguém ampliar o topo um dia, eles não ficam de fora sem ninguém ver.
- Nenhum job usa `GITHUB_TOKEN` em `gh` ou `curl`, nem precisa de `security-events`, `id-token`, `packages`, `pull-requests`, `checks` ou `statuses`. `actions/cache`, `actions/upload-artifact` e o cache GHA do buildx usam o token de runtime do Actions, que não passa pelo bloco `permissions`. Prova disso: `e2e-web` e `compose` já rodam verdes na main só com `contents: read`.
- Ruleset `otilc-rules` (ID 24737510, ativo na branch padrão): 9 entradas com 8 nomes, que são os `name:` dos jobs: `Formatação, tipos e testes unitários`, `API com Postgres real`, `Build da API e da loja`, `e2e-web`, `compose`, `Segredos (gitleaks)`, `Análise estática (Semgrep)`, `Dependências de produção`. O Semgrep aparece duas vezes, com e sem `integration_id` 15368 (app GitHub Actions). O painel é do Pedro e nenhum agente mexe nele.
- O PR também leva a linha 033 do scorecard, com os dados da nota "spec-033 e2e web CI" (seção "Dados da linha 033 do scorecard").

## Escopo

1. `.github/workflows/ci.yml`: bloco `permissions:` no topo do workflow, com exatamente `contents: read`, e remoção dos blocos `permissions` dos jobs `e2e-web` e `compose`. Nada mais muda no arquivo.
2. Nenhum escopo além de `contents: read`. Se algum job falhar com 403 ou erro de permissão no PR, a Forja para e avisa a Bússola antes de ampliar qualquer escopo. Ampliar volta para o Pedro.
3. `.github/workflows/security.yml` sem diff.
4. `docs/agents/scorecard.md`: linha 033 no formato das linhas 030 a 032, num commit separado. Uso: leitura depois da spec, informada pelo Pedro: sessão 74%, semana 19%; consumo da spec ~3% da semana (16% depois do #50 → 19%).

## Arquivos permitidos

Somente estes caminhos podem ser alterados:

- `.github/workflows/ci.yml`
- `docs/agents/scorecard.md`

## Fora do escopo

- Guarda automática contra regressão (regra Semgrep, zizmor ou parecida que exija `permissions` no topo). Fica registrada como candidata na nota da spec.
- Qualquer mudança no ruleset, nas configurações do repositório ou em outro painel do GitHub, inclusive a entrada duplicada do Semgrep.
- As outras ressalvas da 033 (artefato do Playwright com senha e cookie do admin de teste; token de runtime exposto no job `compose`).
- Renomear jobs, mexer em gatilhos, concorrência, actions ou passos.

## Critérios de aceite

- [ ] (a) `ci.yml` e `security.yml` têm `permissions:` no topo com exatamente `contents: read`.
- [ ] (b) Nenhum job nos dois arquivos tem bloco `permissions` (`grep -n 'permissions' .github/workflows/*.yml` mostra uma linha por arquivo, no topo).
- [ ] (c) `actionlint` limpo nos dois arquivos.
- [ ] (d) CI e Segurança verdes no PR e na main depois do merge.
- [ ] (e) Os nomes de check do PR batem com os 8 nomes do ruleset listados no Contexto (conferência da Formiga).
- [ ] (f) Nenhuma linha `name:` de job muda (`git diff origin/main -- .github/workflows` sem linha `name:`).
- [ ] (g) `git diff --name-only origin/main` lista só `.github/workflows/ci.yml`, `docs/agents/scorecard.md` e esta spec.
- [ ] (h) `npm run format:check` verde (o scorecard passa pelo Prettier).

## Notas para o revisor

- Confira que o topo cobre todos os jobs do `ci.yml` e que nenhum job ficou com bloco próprio.
- O token efetivo não muda hoje, porque o padrão do repositório já é `read`. O PR não deve dizer que fecha uma falha.
- Revisão: Lente, mais uma 2ª revisão curta da Faísca, por ser segurança de CI.
