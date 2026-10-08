# Prompts para colar nos painéis da Alethe

Cada agente roda em sua própria worktree/branch. Cole o prompt correspondente no painel do agente.
Os prompts são curtos de propósito: as regras estão no `AGENTS.md` e o escopo está na spec.

## Prompt de execução (qualquer agente, qualquer spec)

Troque `NNN-NOME` pela spec, `PAPEL` pelo que está na linha `Papel:` da spec e `NNN` pelo número.

```text
Atue conforme docs/agents/roles/PAPEL.md e execute a spec em specs/NNN-NOME.md.

Para testes de integração use TEST_DATABASE_URL=postgres://otilc:otilc@localhost:5432/otilc_test_NNN

1. Leia AGENTS.md, o papel e a spec inteira (e as ADRs que ela citar) antes de começar.
2. Resuma em até 5 linhas o seu plano e liste os arquivos que vai criar ou alterar. Confirme que todos estão em "Arquivos permitidos". Espere meu "ok".
3. Implemente com commits pequenos (Conventional Commits).
4. Rode npm run format:check && npm run typecheck && npm test (e npm run test:e2e se mexeu na API) até tudo ficar verde.
5. Faça push da branch e abra o PR com título "[spec-NNN] ..." usando o template, marcando cada critério de aceite.

Se precisar alterar algo fora do escopo, ou se o contrato parecer errado, pare e me explique em vez de mudar.
```

O passo 2 (plano + "ok") custa 1 minuto e evita o maior desperdício de tokens: o agente seguir na direção errada por meia hora.

## Prompt de revisão cruzada

Use um agente de **outro fornecedor** que não o autor (ex.: Codex revisa PR do Claude Code e vice-versa), na worktree da spec.

```text
Atue conforme docs/agents/roles/revisor.md.
Revise o que a branch atual mudou em relação a origin/main, contra specs/NNN-NOME.md, AGENTS.md e as ADRs citadas.
```

Lição da spec-001: um revisor que só confere a spec acha pouco. O papel `revisor` obriga a segunda pergunta ("o design tem buracos?").

## Prompt de correção após revisão

```text
O revisor apontou os itens abaixo no PR da spec-NNN. Corrija só os bloqueantes, mantendo o escopo da spec, e rode os testes de novo.

<cole aqui os itens bloqueantes>
```

## Passagem de contexto entre agentes

Se um agente travar ou acabar o limite de uso no meio da tarefa, use o handoff da Alethe (Claude Code ⇄ Codex). Antes de iniciar o agente de destino, **leia o pacote de contexto**: a redação de dados sensíveis é de melhor esforço.
