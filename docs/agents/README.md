# Kit de agentes — otilc-store

Kit para testar a Alethe como "orquestra" de agentes no e-commerce da OTILC, e reaproveitar nos próximos projetos.

## O que tem aqui

| Arquivo | Para quê |
|---|---|
| `AGENTS.md` | Regras únicas para todos os agentes (Codex lê direto) |
| `CLAUDE.md` | Só importa o `AGENTS.md` para o Claude Code |
| `docs/adr/0001-stack-e-monorepo.md` | Decisão de stack registrada |
| `specs/_TEMPLATE.md` | Modelo de tarefa para qualquer projeto |
| `specs/000` a `005` | As tarefas do teste, em ordem |
| `docs/agents/prompts.md` | Prompts de execução, revisão cruzada e correção |
| `docs/agents/scorecard.md` | Ficha para decidir se a Alethe fica |
| `scripts/new-task.sh` | Cria worktree + branch para uma spec |
| `.github/workflows/ci.yml` | Gates: lint, tipos, testes, build, gitleaks, Semgrep, audit |
| `.github/pull_request_template.md` | Template de PR com checklist do humano |

## Preparação (uma vez)

1. Copie o conteúdo deste kit para a raiz do repositório `otilc-store` e faça commit direto na `main` (é o único commit que não passa por PR):
   ```bash
   git add . && git commit -m "chore: kit de agentes (AGENTS.md, specs, CI)" && git push
   ```
2. No GitHub, em **Settings → Branches**, crie uma regra para a `main`: exigir PR e exigir os checks do CI passando. Isso garante, no nível do GitHub, que nenhum agente faz merge sozinho.
3. Na Alethe:
   - Crie o projeto apontando para a pasta do `otilc-store`.
   - Confira na aba de agentes que Claude Code e Codex estão instalados e logados.
   - Na aba MCP, deixe os mesmos servidores para os dois agentes (se tiver o do GitHub, ótimo).
   - Mantenha o **Remote Control desligado**.
4. Autentique o `gh` (`gh auth login`); a revisão de PR da Alethe usa ele.

## Roteiro do teste

O paralelismo só começa depois que a fundação e o contrato existem. Pular essa ordem é a forma mais rápida de concluir que "multiagente não funciona".

### Fase 1 — Fundação (sequencial, 1 agente)

```bash
scripts/new-task.sh 000 scaffold
```
Claude Code executa a spec-000. Você revisa e faz merge.

### Fase 2 — Contrato (sequencial, revisão pesada sua)

```bash
scripts/new-task.sh 001 contratos
```
Claude Code executa. Peça ao Codex a revisão cruzada. **Leia o `openapi.yaml` e o `schema.prisma` inteiros** antes do merge — é a decisão mais cara de mudar.

### Fase 3 — Rodada paralela (3 agentes ao mesmo tempo)

```bash
scripts/new-task.sh 002 api-catalogo
scripts/new-task.sh 003 web-catalogo
scripts/new-task.sh 004 seed
```

Na Alethe, um painel por worktree:

| Painel | Agente | Spec |
|---|---|---|
| 1 | Claude Code | 002 — API |
| 2 | Codex | 003 — páginas |
| 3 | OpenCode / Copilot / Cursor | 004 — seed |

Enquanto eles trabalham, você **não escreve código**: aprova planos, responde dúvidas e começa a revisar o primeiro PR que chegar. Anote os tempos no scorecard.

Revisão cruzada: Codex revisa o 002, Claude Code revisa o 003 e o 004.

### Fase 4 — Integração (sequencial)

```bash
scripts/new-task.sh 005 e2e
```
O agente que foi melhor na Fase 3 liga web na API e escreve os e2e. As divergências que aparecerem aqui medem quão bem o contrato funcionou.

### Fase 5 — Decisão

Preencha `docs/agents/scorecard.md` e decida. Ajuste o `AGENTS.md` com o que aprendeu (ex.: regras que os agentes ignoraram).

## Regras de ouro

- Agente nunca faz merge. Você sempre lê o diff inteiro.
- Spec boa = escopo fechado + arquivos permitidos + critérios verificáveis.
- Peça o plano antes do código (está no prompt de execução). Corrigir direção cedo é a maior economia de tokens.
- Tarefa pequena demais para spec? Faça você mesmo, é mais rápido.

## Reaproveitando em outros projetos

Copie `AGENTS.md`, `CLAUDE.md`, `specs/_TEMPLATE.md`, `docs/agents/`, `scripts/` e `.github/`. Reescreva as seções "O projeto", "Stack" e "Comandos" do `AGENTS.md` e as specs. O resto (fluxo, segurança, revisão cruzada, CI) vale para qualquer projeto.
