# Roteamento — qual agente faz o quê

Tabela viva: quem executa e quem revisa cada papel (`docs/agents/roles/`).
Cada linha se apoia em evidência do `scorecard.md`, não em impressão. Reavalie a cada 5 specs ou quando um agente mudar de versão.

Última revisão: 2026-10-28, com a formação nova do time (spec-012). Evidências das specs 001 a 007, 009 e 010 do otilc-store.

## Formação atual

| Agente  | Posição                             | Modelo                 | Dono de                                                                    |
| ------- | ----------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| Pedro   | Product Owner                       | humano                 | prioridade, escopo, merge, produção, segredos                              |
| Bússola | Tech Lead / Orquestradora           | Fable 5.1              | specs, roteamento, notas, consolidação, scorecard                          |
| Forja   | Dev Principal                       | Opus 5.5 (Claude Code) | back-end, banco/migrations, segurança, infra (workflows, config de deploy) |
| Faísca  | Dev Secundária                      | Opus 5.5 (Claude Code) | front-end, documentação, módulos paralelos                                 |
| Formiga | Operadora de CI/CD e Reconhecimento | Gemini 3.8 Flash       | vigiar CI, triagem de logs, re-run, smoke test, levantar fatos do repo     |
| Lente   | Revisora                            | Codex (OpenAI)         | revisão de todo PR, em sandbox só leitura ([revisor](roles/revisor.md))    |

Roteamento:

- back-end, banco, segurança, infra → Forja executa
- front-end, docs → Faísca executa
- revisão de todo PR → Lente (outro fornecedor, só leitura); em segurança, banco e pagamento, segunda revisão pelo outro dev (Faísca nos PRs da Forja, Forja nos da Faísca)
- CI, logs, smoke test, fatos do repo → Formiga ([cicd](roles/cicd.md))
- trabalho paralelo → contrato primeiro, depois fronteira de arquivos por dev

## Tabela

As evidências até a spec-009 vêm da formação anterior (Claude Code, Codex e OpenCode). Forja e Faísca rodam no Claude Code, por isso herdam a evidência do Claude onde o papel é o mesmo.

| Papel       | Executor principal | Alternativa                               | Revisor                            | Confiança | Evidência                                                                                                                                                                          |
| ----------- | ------------------ | ----------------------------------------- | ---------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`   | Forja              | Faísca                                    | Lente + Faísca (banco)             | média     | 001, 002, 005 e 007 (Claude) entregues dentro do escopo. A revisão melhorou muito quando o revisor passou a usar `revisor.md` (005).                                               |
| `frontend`  | Faísca             | Forja                                     | Lente + CI                         | baixa     | 003 (Codex) rápida, mas com 4 bloqueadores achados na revisão. 006 (Claude) com testes fortes, mas reprovou no Semgrep, e a revisão do Codex não pegou.                            |
| `seguranca` | Forja              | Faísca                                    | Lente + Faísca                     | baixa     | 010 (Forja) entregue no escopo, 0 bloqueadores. Antes: 004 e 009 com OpenCode, que perguntou antes de agir quando o critério era ambíguo (009).                                    |
| `revisor`   | Lente              | o dev que não é o autor (Forja ou Faísca) | humano lê o diff inteiro           | média     | Claude achou problemas reais em #9 (4 bloqueadores) e #14 (3 itens, um que o humano não viu). Faísca revisou #18 (2 ressalvas). Codex conferia escopo, mas achava pouco de design. |
| `cicd`      | Formiga            | —                                         | Bússola (recebe o resumo e decide) | baixa     | Papel novo (spec-012). Reconhecimento de `docs/agents` entregue na spec-012; ainda sem spec no scorecard.                                                                          |

Confiança:

- **baixa**: 1 ou 2 specs, ou resultados misturados.
- **média**: 3 ou mais specs consistentes.
- **alta**: 5 ou mais specs consistentes em mais de um projeto.

## Regras fixas

1. **O revisor nunca é o autor, e de preferência é de outro fornecedor.** Mesmo modelo revisando a si mesmo repete os mesmos pontos cegos. Forja e Faísca são do mesmo fornecedor (Opus 5.5), por isso desde 2026-10-28 a Lente (Codex) revisa todo PR. Em segurança, banco e pagamento há segunda revisão pelo outro dev, também com `roles/revisor.md` em modo só leitura, começando por 3 formas de o PR quebrar em produção, e o Pedro lê o diff inteiro.
2. **O CI é a rede de segurança**, não o revisor. O Semgrep pegou na 006 o que a revisão do agente deixou passar. Nenhum PR entra sem todos os checks verdes (testes, Semgrep, gitleaks).
3. **O revisor roda sem poder de escrita:** `claude --permission-mode plan` ou `codex --sandbox read-only`.
4. **O revisor recebe a descrição do PR** salva em arquivo (`gh pr view NN > /tmp/pr-NN.md`), porque no modo só leitura ele não chama o `gh`.
5. **Merge é sempre humano** (Pedro), depois de ler o diff inteiro.

## Como atualizar esta tabela

- Ao fim de cada spec, preencha a linha dela no `scorecard.md`.
- Se um agente errar a mesma coisa duas vezes no mesmo papel, desça a confiança ou troque o executor.
- Se o revisor deixar passar algo que o CI ou o humano pegou, anote no scorecard. Isso mede o revisor, não o autor.
- Para um projeto novo, copie a tabela com a confiança rebaixada um nível: a evidência vem de outra stack.
