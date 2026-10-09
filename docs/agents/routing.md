# Roteamento — qual agente faz o quê

Tabela viva: quem executa e quem revisa cada papel (`docs/agents/roles/`).
Cada linha se apoia em evidência do `scorecard.md`, não em impressão. Reavalie a cada 5 specs ou quando um agente mudar de versão.

Última revisão: 2026-10-09, depois das specs 001 a 007 e 009 do otilc-store.

## Tabela

| Papel       | Executor principal | Alternativa | Revisor                  | Confiança | Evidência                                                                                                                                                               |
| ----------- | ------------------ | ----------- | ------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`   | Claude Code        | Codex       | Codex (com papel)        | média     | 001, 002, 005 e 007 entregues dentro do escopo. A revisão do Codex melhorou muito quando passou a usar `revisor.md` (005).                                              |
| `frontend`  | Claude Code        | Codex       | Codex + CI               | baixa     | 003 (Codex) rápida, mas com 4 bloqueadores achados na revisão. 006 (Claude) com testes fortes, mas reprovou no Semgrep, e a revisão do Codex não pegou.                 |
| `seguranca` | OpenCode           | Claude Code | Claude Code              | média     | 004 e 009 entregues no escopo. Pergunta antes de agir quando o critério é ambíguo (009).                                                                                |
| `revisor`   | Claude Code        | Codex       | humano lê o diff inteiro | média     | Claude achou problemas reais em #9 (4 bloqueadores) e #14 (3 itens, um que o humano não viu). Codex confere escopo e critérios com evidência, mas acha pouco de design. |

Confiança:

- **baixa**: 1 ou 2 specs, ou resultados misturados.
- **média**: 3 ou mais specs consistentes.
- **alta**: 5 ou mais specs consistentes em mais de um projeto.

## Regras fixas

1. **O revisor é sempre de outro fornecedor** que não o autor. Mesmo modelo revisando a si mesmo repete os mesmos pontos cegos.
2. **O CI é a rede de segurança**, não o revisor. O Semgrep pegou na 006 o que a revisão do agente deixou passar. Nenhum PR entra sem todos os checks verdes.
3. **O revisor roda sem poder de escrita:** `codex --sandbox read-only` ou `claude --permission-mode plan`.
4. **O revisor recebe a descrição do PR** salva em arquivo (`gh pr view NN > /tmp/pr-NN.md`), porque no modo só leitura ele não chama o `gh`.
5. **Merge é sempre humano**, depois de ler o diff inteiro.

## Como atualizar esta tabela

- Ao fim de cada spec, preencha a linha dela no `scorecard.md`.
- Se um agente errar a mesma coisa duas vezes no mesmo papel, desça a confiança ou troque o executor.
- Se o revisor deixar passar algo que o CI ou o humano pegou, anote no scorecard. Isso mede o revisor, não o autor.
- Para um projeto novo, copie a tabela com a confiança rebaixada um nível: a evidência vem de outra stack.
