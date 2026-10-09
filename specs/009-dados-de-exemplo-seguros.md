# spec-009 — Dados de exemplo que não parecem credenciais reais

- Papel: `seguranca`
- Agente sugerido: OpenCode
- Depende de: nenhuma
- Pode rodar em paralelo com: spec-006 (não mexem nos mesmos arquivos)
- Branch: `spec-009-dados-de-exemplo-seguros`

## Objetivo

Trocar os e-mails e senhas de exemplo/teste que usam o domínio real da marca (`otilc.com.br`) por dados claramente fictícios. Um scanner público (GitGuardian) acusou "Company Email Password" no repositório: é falso positivo (são dados inventados), mas o repositório é público e faz parte do portfólio.

## Contexto

Ocorrências conhecidas (confira com `git grep -n "otilc\.com\.br"` e `git grep -n "uma-senha-bem-longa\|senha-errada\|senha-secreta"`):

- `docs/api/admin.md` (exemplo de login e de resposta)
- `apps/web/src/lib/admin-api.mock.ts`
- `apps/api/src/admin-auth/new-admin.spec.ts`, `apps/api/src/admin-auth/password.spec.ts`
- `apps/api/src/db/seed.spec.ts`
- `apps/api/test/admin-auth.e2e-spec.ts`, `apps/api/test/admin-catalog.e2e-spec.ts`, `apps/api/test/admin-orders.e2e-spec.ts`

## Regras

- E-mails: domínios reservados para exemplo (`example.com` na documentação; `example.test` nos testes).
- Senhas em testes de integração: geradas na hora (`randomBytes(...).toString('base64url')`), nunca constante no arquivo.
- Senhas em testes unitários de hash (onde o valor fixo é necessário): prefixo `teste-` e texto que deixe claro que é fictício (ex.: `teste-nao-e-uma-senha-real`).
- URL de banco em teste: credenciais `usuario:teste-ficticio`.
- O comportamento testado não muda: só os dados.

## Arquivos permitidos

- Os arquivos listados em "Contexto" (somente os dados de exemplo/teste)

## Fora do escopo

- Reescrever o histórico do git (não é credencial real).
- Mudar regras de negócio, contrato ou `.github/`.

## Critérios de aceite

- [ ] `git grep -n "otilc\.com\.br"` não encontra nada
- [ ] `git grep -nE "uma-senha-bem-longa|senha-errada-mas-longa|senha-secreta"` não encontra nada
- [ ] Nenhum teste de integração tem senha constante
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e` verdes
