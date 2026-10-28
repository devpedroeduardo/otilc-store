# Papéis

Um papel diz **o que** o agente cuida e **como** ele deve pensar. Ele não fala de stack: a stack fica no `AGENTS.md` de cada projeto. Por isso os mesmos papéis servem para qualquer projeto e para qualquer agente (Claude Code, Codex, OpenCode...).

| Papel                     | Quando usar                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| [backend](backend.md)     | API, regras de negócio, banco, jobs                                    |
| [frontend](frontend.md)   | telas, componentes, acessibilidade, consumo da API                     |
| [seguranca](seguranca.md) | dependências, configurações, endurecimento, segredos                   |
| [revisor](revisor.md)     | revisão de PR de outro agente (nunca do próprio)                       |
| [cicd](cicd.md)           | vigiar CI, triagem de logs, re-run, smoke test, levantar fatos do repo |

Como usar: a spec diz o papel na linha `Papel:`, e o prompt de execução começa com "Atue conforme docs/agents/roles/<papel>.md".

Qual agente veste qual papel não é decidido aqui: isso sai das medições do `docs/agents/scorecard.md` e fica no [`routing.md`](../routing.md). Hoje o papel `revisor` é da Lente (Codex, outro fornecedor, sandbox só leitura) em todo PR; em segurança, banco e pagamento, o dev que não é o autor faz a segunda revisão.
