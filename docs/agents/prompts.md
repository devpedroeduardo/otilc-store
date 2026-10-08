# Prompts para colar nos painéis da Alethe

Cada agente roda em sua própria worktree/branch. Cole o prompt correspondente no painel do agente.
Os prompts são curtos de propósito: as regras estão no `AGENTS.md` e o escopo está na spec.

## Prompt de execução (qualquer agente, qualquer spec)

```text
Você vai executar a spec em specs/NNN-NOME.md.

1. Leia AGENTS.md e a spec inteira antes de começar.
2. Resuma em até 5 linhas o seu plano e liste os arquivos que vai criar ou alterar. Confirme que todos estão em "Arquivos permitidos". Espere meu "ok".
3. Implemente com commits pequenos (Conventional Commits).
4. Rode pnpm lint && pnpm typecheck && pnpm test até tudo ficar verde.
5. Abra o PR com título "[spec-NNN] ..." usando o template, marcando cada critério de aceite.

Se precisar alterar algo fora do escopo, ou se o contrato parecer errado, pare e me explique em vez de mudar.
```

O passo 2 (plano + "ok") custa 1 minuto e evita o maior desperdício de tokens: o agente seguir na direção errada por meia hora.

## Prompt de revisão cruzada

Use um agente **diferente** do autor (ex.: Codex revisa PR do Claude Code e vice-versa). Na Alethe, rode pela revisão de PR na worktree do agente (modo somente leitura).

```text
Revise o PR da branch spec-NNN-... contra specs/NNN-NOME.md e AGENTS.md. Não altere código.

Responda em quatro seções:
1. Critérios de aceite: cada um atendido, parcialmente ou não, com evidência (arquivo:linha ou teste).
2. Escopo: algum arquivo alterado fora de "Arquivos permitidos"?
3. Problemas: bugs, segurança (validação de entrada, segredos, SQL), testes fracos ou ausentes. Classifique como bloqueante ou sugestão.
4. Veredito: aprovar, aprovar com ressalvas ou pedir mudanças.
```

## Prompt de correção após revisão

```text
O revisor apontou os itens abaixo no PR da spec-NNN. Corrija só os bloqueantes, mantendo o escopo da spec, e rode os testes de novo.

<cole aqui os itens bloqueantes>
```

## Passagem de contexto entre agentes

Se um agente travar ou acabar o limite de uso no meio da tarefa, use o handoff da Alethe (Claude Code ⇄ Codex). Antes de iniciar o agente de destino, **leia o pacote de contexto**: a redação de dados sensíveis é de melhor esforço.
