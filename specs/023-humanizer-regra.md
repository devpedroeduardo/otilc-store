# spec-023 — Regra do humanizer para a prosa que sai do time

- Papel: docs — ver docs/agents/roles/
- Agente sugerido: Faísca (Claude Code)
- Depende de: nenhuma
- Pode rodar em paralelo com: qualquer spec que não mexa em `AGENTS.md` nem no template de PR
- Branch: `spec-023-humanizer-regra`

## Objetivo

O `AGENTS.md` e o template de PR passam a dizer que toda prosa que sai do time passa pela skill `humanizer` antes de sair: quem aplica, em quê, o que não muda e o que faz o agente que não tem a skill.

## Contexto

- Decisões do Pedro (2026-11-02) na nota "Grilling Humanizer A" do fichário "Fluxo OTILC", 10 respostas. Fatos na nota "Recon Humanizer A".
- O `CLAUDE.md` só importa o `AGENTS.md` (`AGENTS.md:3-4`: fonte única, não duplicar). Por isso a regra vai no `AGENTS.md` e o `CLAUDE.md` não muda: o Claude Code a recebe pelo import, e o Codex e o OpenCode leem o `AGENTS.md` direto.
- A skill fica em `~/.claude/skills/humanizer/SKILL.md`. Forja, Faísca e Bússola (Claude Code) e a Formiga (OpenCode) têm acesso. A Lente (Codex) não tem.
- A skill sempre reescreve e foi escrita para inglês. Em português, valem os padrões equivalentes.
- A nota "Manual do Time" é atualizada pela Bússola, fora do git, junto com esta spec.
- Esta spec leva também a linha 022 do scorecard (decisão do Pedro), que substitui o PR #40.

## O que a regra diz (conteúdo mínimo)

1. **Em quê:** docs, README, `specs/*.md`, corpo de PR, comentários de PR no GitHub, corpo da mensagem de commit e comentários de código novos ou alterados com mais de uma frase.
2. **Fora:** assunto do commit (Conventional Commits, uma linha), mensagens entre agentes, notas do Maestri, textos da interface e `docs/api/**` quando a spec não permitir mexer no contrato.
3. **Quem aplica e quando:** o autor, no próprio texto, antes do commit ou do PR. A Lente não revisa estilo.
4. **O que não muda:** fatos, números, `arquivo:linha`, código, comandos, nomes, tabelas e citações. Texto em português usa os padrões equivalentes, sem traduzir nada.
5. **Agente sem a skill:** se o texto vai sair, lê `~/.claude/skills/humanizer/SKILL.md` se puder; senão, entrega o texto ao dev autor (ou à Faísca), que aplica antes de publicar. A Lente não aplica nem cobra, porque o veredito dela fica no terminal.
6. No `AGENTS.md`, só o nome da skill e o caminho global, sem versão.

## Arquivos permitidos

- `AGENTS.md` (uma seção curta; o resto do arquivo intocado)
- `.github/pull_request_template.md` (uma linha no checklist: "Prosa do PR, commits e docs passou pelo humanizer")
- `docs/agents/scorecard.md` (só a linha 022)

## Fora do escopo

- Limpar o README e os `docs/` atuais com o humanizer (spec B).
- Mudar o `CLAUDE.md`, a skill, `~/.claude/CLAUDE.md` ou a configuração do Codex e do OpenCode.
- Versionar a skill no repo.

## Critérios de aceite

- [ ] `grep -n humanizer AGENTS.md` acha a seção, que cobre os itens 1 a 6 acima.
- [ ] `CLAUDE.md` continua com uma linha (`@AGENTS.md`); `git diff main -- CLAUDE.md` vazio.
- [ ] O template de PR tem a linha nova no checklist e nada mais muda nele.
- [ ] O scorecard tem a linha 022 logo depois da 021, com o uso informado pelo Pedro.
- [ ] A seção nova, o corpo do PR e os corpos dos commits passaram pelo humanizer (é o primeiro uso).
- [ ] `npm run format:check && npm run typecheck && npm test` verdes.

## Notas para o revisor

- Conferir se a seção não duplica nem contradiz `AGENTS.md:70` (idioma) e `:56` (Conventional Commits).
- Conferir se a regra cabe em poucas linhas: ela é lida no começo de toda sessão de todo agente.
