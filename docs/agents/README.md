# Kit de agentes — otilc-store

Como usar vários agentes de IA em paralelo neste repositório (testando a Alethe como workspace) e como reaproveitar o fluxo em outros projetos.

## O que tem aqui

| Arquivo                            | Para quê                                                         |
| ---------------------------------- | ---------------------------------------------------------------- |
| `AGENTS.md` (raiz)                 | Regras únicas para todos os agentes (Codex lê direto)            |
| `CLAUDE.md` (raiz)                 | Só importa o `AGENTS.md` para o Claude Code                      |
| `docs/adr/`                        | Decisões de arquitetura (0001 stack, 0002 autenticação do admin) |
| `specs/_TEMPLATE.md`               | Modelo de tarefa                                                 |
| `specs/001` a `006`                | Tarefas do teste: painel administrativo + segurança              |
| `docs/agents/prompts.md`           | Prompts de execução, revisão cruzada e correção                  |
| `docs/agents/scorecard.md`         | Ficha para decidir se a Alethe fica                              |
| `scripts/new-task.sh`              | Cria worktree + branch + banco de teste próprio para uma spec    |
| `.github/workflows/security.yml`   | Gitleaks, Semgrep e `npm audit` (complementa o `ci.yml`)         |
| `.github/pull_request_template.md` | Template de PR com checklist do humano                           |

## Preparação (uma vez)

1. Ambiente local funcionando no WSL, como no README principal (`npm install`, `docker compose up -d db`, `.env` copiados, `db:migrate`, `db:seed`, `npm test`, `npm run test:e2e`).
2. No GitHub, **Settings → Branches → Add rule** para `main`:
   - Require a pull request before merging
   - Require status checks: os 3 jobs do `CI` e o `Segredos (gitleaks)`.
   - Semgrep: deixe fora dos obrigatórios até a primeira execução. Se ele apontar algo no código existente, trate como uma spec própria e só depois torne obrigatório.
3. Agentes instalados **dentro do WSL** (`claude`, `codex` e um terceiro, ex.: `opencode`), logados.
4. `gh auth login` no WSL (a revisão de PR da Alethe usa o `gh`).
5. Na Alethe: projeto apontando para o repositório; Remote Control **desligado**.

## Roteiro do teste

```
001 contrato  ──►  002 API auth  ─┐
   (sozinho)       003 telas web  ├─ paralelo ─►  005 API admin  ─►  006 integração + E2E
                   004 segurança ─┘
```

### Fase 1 — Contrato (sequencial, revisão pesada sua)

```bash
scripts/new-task.sh 001 contrato-admin
```

Claude Code executa; Codex faz a revisão cruzada. **Leia `packages/shared/src/admin.ts`, a migração SQL e `docs/api/admin.md` inteiros** antes do merge.

### Fase 2 — Rodada paralela (3 agentes ao mesmo tempo)

```bash
scripts/new-task.sh 002 api-auth-admin
scripts/new-task.sh 003 web-painel-admin
scripts/new-task.sh 004 seguranca-dependencias
```

| Painel | Agente                      | Spec                                       |
| ------ | --------------------------- | ------------------------------------------ |
| 1      | Claude Code                 | 002 — login de admin na API                |
| 2      | Codex                       | 003 — telas do painel com dados de exemplo |
| 3      | OpenCode / Copilot / Cursor | 004 — vulnerabilidades e trava da seed     |

Cada painel: shell → `cd` na worktree → `export TEST_DATABASE_URL=...` (o script imprime) → inicia o agente → cola o prompt de execução.

Enquanto trabalham, você **não escreve código**: aprova planos, responde dúvidas e revisa o primeiro PR que chegar. Revisão cruzada: Codex revisa 002 e 004; Claude Code revisa 003. Anote tudo no scorecard.

### Fase 3 — Endpoints do admin (sequencial)

```bash
scripts/new-task.sh 005 api-admin-produtos-pedidos
```

### Fase 4 — Integração e E2E

```bash
scripts/new-task.sh 006 integracao-admin-e2e
```

As divergências entre API e web que aparecerem aqui medem se o contrato funcionou.

### Fase 5 — Decisão

Preencha `docs/agents/scorecard.md`. Ajuste o `AGENTS.md` com o que aprendeu.

## Regras de ouro

- Agente nunca faz merge. Você sempre lê o diff inteiro.
- Spec boa = escopo fechado + arquivos permitidos + critérios verificáveis.
- Peça o plano antes do código (está no prompt de execução): corrigir direção cedo é a maior economia de tokens.
- Pix (pagamento real, webhook) fica para depois do teste e com você no comando: é a parte de maior risco do projeto.

## Reaproveitando em outros projetos

Copie `AGENTS.md`, `CLAUDE.md`, `specs/_TEMPLATE.md`, `docs/agents/`, `scripts/new-task.sh` e `.github/`. Reescreva no `AGENTS.md` as seções "O projeto", "Stack", "Comandos" e "Convenções" **olhando o código real** — regra genérica que não bate com o repositório faz o agente trocar a sua stack.
