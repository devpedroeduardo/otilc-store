# Ficha de avaliação — Alethe no otilc-store

Preencha durante o teste. No fim, a decisão sai dos números, não da empolgação.

## Por spec

| Spec | PR  | Agente (papel)       | Revisor   | Tempo até PR | Iterações de correção | CI verde de primeira? | Saiu do escopo? | Bloqueantes na revisão | O que escapou do revisor                               | Uso/tokens |
| ---- | --- | -------------------- | --------- | ------------ | --------------------- | --------------------- | --------------- | ---------------------- | ------------------------------------------------------ | ---------- |
| 001  | #2  | Claude (backend)     | Codex     | ?            | ?                     | ?                     | não             | 0                      | revisão rasa (Codex ainda sem o papel `revisor`)       | ?          |
| 002  | #7  | Claude (backend)     | não feita | ?            | ?                     | ?                     | não             | —                      | —                                                      | ?          |
| 003  | #9  | Codex (frontend)     | Claude    | ?            | 1 (lockfile)          | ?                     | não             | 4                      | —                                                      | ?          |
| 004  | #8  | OpenCode (seguranca) | não feita | ?            | ?                     | ?                     | não             | —                      | —                                                      | ?          |
| 005  | #12 | Claude (backend)     | Codex     | ?            | 0                     | ?                     | não             | 0 (1 sugestão válida)  | —                                                      | ?          |
| 006  | #15 | Claude (frontend)    | Codex     | ?            | 1                     | não (Semgrep: RegExp) | não             | 0                      | Semgrep (pegou o CI) e banco `otilc_test_006` (humano) | ?          |
| 007  | #11 | Claude (backend)     | Codex     | ?            | ?                     | ?                     | não             | ?                      | ?                                                      | ?          |
| 009  | #14 | OpenCode (seguranca) | Claude    | ?            | 0                     | sim                   | não             | 0 (3 sugestões)        | —                                                      | ?          |

Preencha os `?` com o que você lembra ou vê nos PRs (aba Checks e histórico de commits). Os demais vieram das revisões.

## Paralelismo (rodada 002 + 003 + 004)

- Tempo total do início da rodada até os três PRs mergeados:
- Quanto tempo você **sozinho** levaria para as três (estimativa honesta):
- Conflitos de merge entre os três PRs (quantos, e em quais arquivos):
- Divergências entre API e web encontradas na spec-006: 0 de contrato; 2 registradas (STAFF vê o preço desabilitado em vez de escondido; cache de 30s da loja)
- Tempo que você passou revisando (somado):

## A ferramenta

Notas de 1 a 5:

- Facilidade para acompanhar vários agentes ao mesmo tempo:
- Funcionamento com o projeto dentro do WSL:
- Retomada de sessão depois de fechar/reabrir:
- Painel de git/worktrees e revisão de PR:
- Gestão de MCP compartilhado entre agentes:
- Consumo de RAM / estabilidade (travou? quantas vezes?):
- Atrito geral (o quanto ela atrapalhou em vez de ajudar):

## Comparação entre agentes

- Qual agente seguiu melhor o AGENTS.md e o escopo? Todos ficaram no escopo. OpenCode foi o mais cauteloso (parou e perguntou sobre o critério ambíguo da 009).
- Qual escreveu testes melhores? Claude: na 006, teste de controle do CSRF (Origin forjado → 403) e senhas geradas no globalSetup.
- Qual revisão cruzada achou problema real que o autor deixou passar? Claude na #9 (4 bloqueadores, entre eles o cookie com path errado) e na #14 (dado fictício esquecido em `packages/shared`). Ver `routing.md`.

## Decisão

Fica com a Alethe se **pelo menos 3** forem verdade:

- [ ] Rodada paralela levou menos de 60% do tempo que você levaria sozinho
- [ ] No máximo 1 conflito de merge sério na rodada paralela
- [ ] Revisão cruzada achou pelo menos 1 problema real
- [ ] Nota de atrito geral ≥ 4
- [ ] Você se sentiu no controle do que estava sendo construído

Resultado:

Ajustes para o próximo projeto (no AGENTS.md, nas specs ou no fluxo):
