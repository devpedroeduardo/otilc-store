# spec-011 — Vulnerabilidades de dependências (CI 6/6)

- Papel: `seguranca` (ver docs/agents/roles/seguranca.md)
- Agente sugerido: Forja (Opus 5.5). Revisor: Faísca (Codex).
- Depende de: nenhuma
- Pode rodar em paralelo com: nenhuma (mexe no `package-lock.json` e no contrato)
- Branch: `spec-011-vulnerabilidades-dependencias`

## Objetivo

O check "Dependências de produção" (`npm audit --omit=dev --audit-level=high`) passa na `main`, sem regressão de comportamento. Depois do merge desta spec, o PR #18 (spec-010) é atualizado com a `main` e fica 6/6.

## Contexto

`npm audit --omit=dev` na `main` (2026-10-28) acusa 6 vulnerabilidades:

| Pacote                     | Versão atual                                  | Severidade        | Advisory                                                                     | Correção esperada                                                         |
| -------------------------- | --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `next`                     | 15.5.27                                       | critical          | GHSA-2464-fhr4-w9xw (RCE no Image Optimization com SVG), GHSA-p3m5-59mp-jv5r | patch na linha 15 (15.5.28 existe)                                        |
| `zod`                      | 3.25.76                                       | high              | GHSA-mrhx-c7xc-m3w5                                                          | **não há 3.x corrigido**: subir para zod 4 (>= 4.6.6)                     |
| `multer`                   | 2.4.0 (via `@nestjs/platform-express` 11.2.7) | high              | GHSA-q7qp-rjg7-q26m                                                          | `overrides` do npm para `multer` >= 2.5.0. **Não** subir o NestJS para 12 |
| `@nestjs/platform-express` | 11.2.7                                        | high (via multer) | —                                                                            | resolvido pelo override acima                                             |
| `body-parser`              | 2.3.0                                         | high              | GHSA-27r3-jxmh-p828                                                          | versão corrigida via lockfile (`npm audit fix` sem `--force`)             |
| `qs`                       | 6.16.0                                        | moderate          | GHSA-6pq8-jhm2-2vcw                                                          | idem                                                                      |

**Esta spec autoriza explicitamente a troca de versão principal do Zod (3 → 4)** e, por isso, mexer em `packages/shared/src/**`. A autorização é para adaptar o código à API do Zod 4, **não** para mudar o contrato: formato dos DTOs, campos, limites e mensagens de erro de validação devolvidas pela API continuam iguais. Se algum comportamento observável mudar inevitavelmente (ex.: texto de mensagem padrão do Zod), pare e reporte antes de seguir.

## Arquivos permitidos

- `package.json` (raiz, só `overrides`), `package-lock.json`
- `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json` (só versões)
- `packages/shared/src/**` (só adaptação à API do Zod 4, sem mudar o contrato)
- `apps/api/src/**` e `apps/web/src/**` **somente** onde o Zod 4 ou o Next 15.5.x quebrarem tipos ou API (o `ZodValidationPipe` é o candidato óbvio). Explique cada ajuste no PR.
- Testes existentes **só** para acompanhar a API nova, sem enfraquecer asserções; testes novos à vontade

## Fora do escopo

- NestJS 12, Next 16, React ou qualquer atualização "de carona".
- `npm audit fix --force`.
- Alterar `.github/workflows/`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/**`, `docs/api/**`.
- Tocar na branch do PR #18 (a atualização dela vem depois do merge desta spec).
- `docs/agents/scorecard.md` (a linha é da Bússola).

## Critérios de aceite

- [ ] `npm audit --omit=dev --audit-level=high` sem achados (colar a saída no PR)
- [ ] `npm ls next zod multer` mostra uma única versão corrigida de cada; Next continua 15.x e NestJS continua 11.x
- [ ] Teste que prova que o `ZodValidationPipe` continua devolvendo o **mesmo** status e formato de corpo de erro para entrada inválida (se já existir, ele tem de passar sem alteração na asserção)
- [ ] Testes do shared (`node:test`) e unitários da API passam sem enfraquecer nenhuma asserção
- [ ] `npm run format:check && npm run typecheck && npm test && npm run test:e2e && npm run build` verdes (e2e com o Postgres do docker compose; se não houver Docker local, dizer isso no PR e apontar o check "API com Postgres real" do CI)
- [ ] CI do PR 6/6
- [ ] PR com a tabela do papel `seguranca`: advisory, pacote, versão antiga → nova, changelog consultado e como verificou

## Notas para o revisor

- Zod 4 muda detalhes de `.error`/`issues`, `z.string().email()` e afins, `default`/`optional` e inferência de tipos. Confira que nenhuma validação ficou mais frouxa (limites de tamanho, `min`/`max`, `int`, `positive`, enums).
- Confira que o preço continua sem vir do navegador e que os testes de concorrência de estoque estão intactos.
- O `overrides` de `multer` precisa ser compatível com `@nestjs/platform-express` 11 (upload não é usado hoje, mas a API tem de subir).
