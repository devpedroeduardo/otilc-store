# spec-012 — Documentar a nova formação do time de agentes

- Papel: `frontend` (documentação) — ver docs/agents/roles/
- Agente sugerido: Faísca (Codex). Revisora: Forja (Claude Code, Opus 5.5, só leitura, papel `revisor`)
- Depende de: nenhuma
- Pode rodar em paralelo com: spec-011 (não toca em `docs/agents/**`)
- Branch: `spec-012-formacao-do-time`

> Numeração: o Pedro pediu como "spec-011", mas esse número já é da spec de vulnerabilidades de dependências. Esta é a spec-012.

## Objetivo

O repositório descreve a formação atual do time (Bússola, Forja, Faísca, Formiga), o papel de Operadora de CI/CD e o pipeline de 11 etapas que toda spec segue, com o padrão de notas no fichário "Fluxo OTILC".

## Contexto

Formação atual (fonte: nota "Manual do Time" no canvas do Maestri):

| Agente  | Posição                             | Modelo                 | Dono de                                                                    |
| ------- | ----------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| Pedro   | Product Owner                       | humano                 | prioridade, escopo, merge, produção, segredos                              |
| Bússola | Tech Lead / Orquestradora           | Fable 5.1              | specs, roteamento, notas, consolidação, scorecard                          |
| Forja   | Dev Principal                       | Opus 5.5 (Claude Code) | back-end, banco/migrations, segurança, infra (workflows, config de deploy) |
| Faísca  | Dev Secundário                      | Codex                  | front-end, documentação, módulos paralelos                                 |
| Formiga | Operadora de CI/CD e Reconhecimento | Gemini Flash           | vigiar CI, triagem de logs, re-run, smoke test, levantar fatos do repo     |

Roteamento:

- back-end, banco, segurança, infra → Forja executa, Faísca revisa
- front-end, docs → Faísca executa, Forja revisa
- CI, logs, smoke test, fatos do repo → Formiga
- trabalho paralelo → contrato primeiro, depois fronteira de arquivos por dev

Pipeline de uma spec (11 etapas):

1. Pedido (Pedro → Bússola)
2. Reconhecimento: Bússola pede fatos à Formiga (nunca lê código)
3. Spec + nota no fichário (Bússola)
4. Build em worktree própria (Forja ou Faísca, por roteamento)
5. PR aberto (autor) → avisa Bússola e Formiga
6. CI: Formiga vigia e manda resumo de até 5 linhas à Bússola
7. Revisão cruzada (o outro dev, só leitura)
8. Correções (autor; máx. 2 rodadas, depois escala ao Pedro)
9. Pronto para merge → Bússola avisa o Pedro (status 🟠)
10. Merge (Pedro) → deploy automático → Formiga faz smoke test
11. Fechamento: scorecard + nota 🟢 (Bússola)

Padrão de notas no fichário "Fluxo OTILC": uma nota "spec-NNN <título>" por spec, copiada da nota "MODELO spec", com cabeçalho `Responsável | Revisor | PR`, linha de Status, checklist (spec, worktree, implementado, testes locais, PR, CI, revisão cruzada, ressalvas, merge, produção, scorecard) e Log com linhas `AAAA-MM-DD HH:MM · agente · evento`. Legenda de status: 🟡 em andamento · 🔵 em revisão · 🟠 aguardando Pedro · 🔴 bloqueado · 🟢 concluído. A Bússola é a dona da nota.

Formiga — o que **nunca** faz: editar workflows, config de deploy, migrations, auth, pagamento; merge; tocar em segredos ou produção; tomar decisão (escala à Bússola).

Estado atual dos arquivos (reconhecimento da Formiga, na main):

- `docs/agents/routing.md`: seções `## Tabela`, `## Regras fixas` (itens 1 a 5), `## Como atualizar esta tabela`. Colunas: Papel, Executor principal, Alternativa, Revisor, Confiança, Evidência. Ainda cita Claude Code, OpenCode e Codex sem a formação nova. Confiança: baixa 1–2 specs, média ≥3, alta ≥5.
- `docs/agents/roles/`: `README.md` (tabela Papel com link | Quando usar), `backend.md`, `frontend.md`, `seguranca.md` (seções `## Sempre`, `## Nunca`, `## Ao terminar`), `revisor.md`.
- `docs/agents/README.md`: seções `## O que tem aqui`, `## Preparação (uma vez)`, `## Roteiro do teste`, `## Regras de ouro`, `## Reaproveitando em outros projetos`.

## Arquivos permitidos

- `docs/agents/routing.md`
- `docs/agents/roles/cicd.md` (novo)
- `docs/agents/roles/README.md`
- `docs/agents/README.md`
- `specs/012-formacao-do-time.md` (esta spec, já escrita pela Bússola)

## Fora do escopo

- `AGENTS.md`, `CLAUDE.md`, `docs/agents/scorecard.md` (o scorecard é preenchido no fechamento, em commit próprio).
- Os demais arquivos de `docs/agents/roles/` (backend, frontend, seguranca, revisor).
- Código, `packages/shared`, `docs/api/**`, `.github/`, banco.
- Reescrever seções que não foram pedidas: mudanças mínimas e localizadas.

## Critérios de aceite

- [ ] `routing.md`: a tabela de papéis mostra a formação atual (Bússola/Fable 5.1 orquestra; Forja/Opus 5.5 back-end, banco, segurança, infra; Faísca/Codex front-end e docs; Formiga/Gemini Flash CI/CD e reconhecimento), com revisor cruzado coerente com o roteamento
- [ ] `routing.md`: as 5 regras fixas continuam presentes (pode ajustar nomes de agente, não o sentido) e a regra de confiança baseada no scorecard (baixa/média/alta e como atualizar) continua igual
- [ ] `roles/cicd.md` existe com as seções `## Sempre`, `## Nunca`, `## Ao terminar` (mesmo formato de `backend.md`), cobrindo vigiar CI, triagem de logs, re-run, smoke test e reconhecimento; e a lista do "Nunca" do Contexto
- [ ] `roles/README.md` cita `cicd.md` na tabela, com link e "Quando usar"
- [ ] `docs/agents/README.md` tem uma seção curta `## Pipeline de uma spec` com as 11 etapas acima e o padrão de notas do fichário "Fluxo OTILC"
- [ ] Todos os links relativos entre esses arquivos resolvem
- [ ] Nenhum segredo, token, ID de projeto ou e-mail real nos textos
- [ ] `git diff --name-only origin/main` só lista arquivos permitidos
- [ ] `npm run format:check && npm run typecheck && npm test` verdes; CI verde

## Notas para o revisor

- Confira que a confiança por scorecard e as regras fixas não perderam sentido na edição.
- Confira que o "Nunca" do `cicd.md` bate com o Manual (sem workflows, deploy, migrations, auth, pagamento).
- Confira coerência entre `routing.md`, `roles/README.md` e o pipeline do `README.md`.
