# spec-013 — AGENTS.md e Roadmap do README com o estado atual

- Papel: docs — ver docs/agents/roles/
- Agente sugerido: Faísca (docs); revisão da Lente
- Depende de: nenhuma
- Pode rodar em paralelo com: qualquer spec que não toque AGENTS.md nem README.md
- Branch: `spec-013-docs-estado-atual`

## Objetivo

O AGENTS.md e o Roadmap do README.md descrevem o que já existe e o que falta, sem chamar de pendente o que já foi entregue e sem citar um provedor de banco que não é o de produção.

## Contexto

- `AGENTS.md:9-10` lista login de administrador e painel administrativo como próximos passos, junto com Pix, e-mail e deploy. Os dois já existem: `apps/api/src/admin-auth`, `apps/web/src/app/admin`, specs 002 a 006.
- O Roadmap do README.md marca como pendentes o painel administrativo (`README.md:123`), o login de administrador (`README.md:124`) e os E2E do fluxo de compra com Playwright (`README.md:126`). Os E2E existem: script `test:e2e:web` em `package.json:24` e a pasta `e2e/` com `compra.spec.ts` e `admin.spec.ts`.
- `README.md:127` diz "Deploy: loja na Vercel, API no Render e banco no Neon". O banco de produção é Supabase, região us-east-1, com RLS habilitado em todas as tabelas do `public` e sem policies (spec-010, migração 0003).
- Os fatos acima foram confirmados pela Formiga na origin/main: ver a nota "spec-013 Docs do estado atual" no fichário "Fluxo OTILC".

## Arquivos permitidos

Somente estes caminhos podem ser criados ou alterados:

- `AGENTS.md`
- `README.md`
- `specs/013-docs-estado-atual.md` (esta spec, no primeiro commit, como nas specs anteriores)

## Fora do escopo

- Qualquer código, teste, workflow, `docs/**`, `packages/shared/**` ou migração.
- Reescrever outras seções do README ou do AGENTS.md além das citadas. Erro encontrado em outra seção vai como ressalva no PR, sem correção.
- Expor dados de produção que não estão no repositório: URL, ID do projeto, chaves ou nomes de host do Supabase.
- Mudar regras de trabalho, segurança ou convenções do AGENTS.md.

## Critérios de aceite

- [ ] O AGENTS.md não chama login de administrador nem painel administrativo de próximos passos. A frase "Já funciona" passa a citá-los.
- [ ] Os próximos passos do AGENTS.md listam só o que ainda falta segundo o Roadmap atualizado.
- [ ] No Roadmap do README.md, login de admin, painel administrativo e E2E com Playwright aparecem como feitos.
- [ ] `git grep -n -i neon -- AGENTS.md README.md` não retorna nada.
- [ ] O item de deploy do Roadmap troca Neon por Supabase e mantém a marcação atual de feito ou pendente. Esta spec não decide se o deploy está concluído.
- [ ] O README.md diz que o banco de produção é Supabase (us-east-1) com RLS habilitado e sem policies, e aponta a spec-010.
- [ ] O diff só toca os arquivos permitidos (`git diff --name-only origin/main...HEAD`).
- [ ] `npm run format:check && npm run typecheck && npm test` verdes.

## Notas para o revisor

- Conferir cada item marcado como feito contra o repositório: pasta, script ou spec que o comprove.
- Conferir que nenhum dado sensível de produção entrou no texto.
- O trecho sobre RLS sem policies deve repetir o efeito descrito na spec-010, sem inventar detalhe novo.
