# spec-024 — Humanizer na prosa atual do README e de docs/

- Papel: docs — ver docs/agents/roles/
- Agente sugerido: Faísca (Claude Code)
- Depende de: spec-023 (regra do humanizer no `AGENTS.md`)
- Pode rodar em paralelo com: qualquer spec que não mexa em `README.md` nem em `docs/`
- Branch: `spec-024-humanizer-docs`

## Objetivo

A prosa que já existe no `README.md` e nos arquivos vivos de `docs/` passa pela skill `humanizer`, seguindo a regra da spec-023. Muda só o estilo: fatos, comandos, caminhos, números, links, títulos, tabelas e blocos de código saem idênticos.

## Contexto

- Decisões do Pedro (2026-11-02) na nota "Grilling Humanizer B" do fichário "Fluxo OTILC", 14 respostas. Fatos na nota "Recon Humanizer B" (main f2fd500).
- São 17 arquivos `.md` em `README.md` e `docs/**`, 1814 linhas. Prosa corrida é cerca de 11%; boa parte do texto a tratar está em itens de lista.
- Os sinais mais frequentes são negrito (329 pares, 165 só em `docs/homologacao-local.md`), travessões (48) e tríades.
- `docs/api/**` é contrato (`AGENTS.md`, seção "O contrato é lei"). Esta spec autoriza mexer **só na prosa explicativa** desses arquivos.
- Cinco títulos sustentam 6 links com âncora (`README.md` → `#roadmap`; `docs/api/admin.md` ↔ `docs/api/pagamentos.md`). O CI não verifica links, só roda o Prettier.
- A linha 023 do scorecard entra neste PR (decisão do Pedro). Ela cabe nas larguras atuais da tabela, então o diff do scorecard é +1 linha.

## Escopo

Entram (prosa e itens de lista):

- `README.md`
- `docs/api/admin.md` e `docs/api/pagamentos.md`, só a prosa explicativa
- `docs/deploy.md`
- `docs/homologacao-local.md`
- `docs/agents/README.md`, só a seção "Pipeline de uma spec" (a partir da linha 84 em f2fd500)
- `docs/agents/routing.md`, `docs/agents/prompts.md` e `docs/agents/roles/*.md`

## Regras da reescrita

1. **Não mudam:** títulos (`^#`), tabelas (inclusive células), blocos de código, trechos em crase, URLs e links, números, `arquivo:linha`, comandos, nomes de campo, códigos e mensagens de erro.
2. **docs/api:** não mudam tabelas de rotas, DTOs, blocos JSON nem nomes de schema.
3. **Negrito:** sai o decorativo. Fica o que marca aviso de segurança ou ação irreversível e o nome de tela ou botão que o leitor procura na interface. Na dúvida, fica.
4. **Homologação:** campos do formulário da seção 8 e ordem dos passos numerados não mudam; só o texto em volta.
5. **Sentido:** regra continua regra, condição continua condição, passos na mesma ordem.
6. Arquivo em que a skill não acha nada a mudar fica como está e conta como revisado.
7. Referências `arquivo:linha` de specs antigas e notas que apontem para esses arquivos podem desalinhar. Não se corrige.

## Arquivos permitidos

- Os arquivos da seção "Escopo", dentro das regras acima
- `docs/agents/scorecard.md` (só a linha 023, copiada da nota "spec-023 Regra do humanizer")

## Fora do escopo

- ADRs (`docs/adr/**`): registro de decisão; a próxima já nasce pela regra.
- `docs/agents/scorecard.md` fora a linha 023, e `docs/agents/README.md` antes da seção "Pipeline de uma spec" (histórico do teste da Alethe).
- `specs/**` antigas.
- `AGENTS.md`, `CLAUDE.md`, template de PR e qualquer código.

## Commits e tamanho

- Um PR, com um commit por grupo: README; docs/api; deploy + homologação; docs/agents; scorecard 023.
- Se o diff passar de ~600 linhas alteradas, a Faísca para e avisa a Bússola antes de abrir o PR; aí o docs/api vira um PR separado.

## Critérios de aceite

- [ ] Todos os arquivos da seção "Escopo" passaram pela skill. O corpo do PR tem uma tabela com cada arquivo, "alterado" ou "sem mudança", e os padrões tratados.
- [ ] `git diff main --stat` só mostra arquivos permitidos.
- [ ] Comparação mecânica main × branch (feita pela Formiga, sem editar arquivos): títulos, tabelas, blocos de código, trechos em crase, URLs e links, números e `arquivo:linha` saem idênticos. Única diferença aceita: a linha 023 do scorecard.
- [ ] As 6 âncoras internas continuam resolvendo.
- [ ] Diff do `docs/agents/scorecard.md` = +1 linha (a 023).
- [ ] Veredito da Lente sem mudança de conteúdo; segunda leitura da Forja só no diff de `docs/api/**`.
- [ ] Corpo do PR e corpos dos commits passaram pelo humanizer.
- [ ] `npm run format:check && npm run typecheck && npm test` verdes; CI verde.

## Notas para o revisor

- Ler com `git diff main --word-diff` procurando mudança de sentido: "deve" que virou "pode", condição perdida, passo que trocou de ordem, aviso que perdeu o destaque.
- Não cobrar estilo; a pergunta é só se o conteúdo é o mesmo.
- Em `docs/api/**`, conferir que nada fora da prosa explicativa mudou.
