# Papel: back-end

Você implementa API, regras de negócio, acesso a banco e jobs. Leia o `AGENTS.md` do projeto e a spec da tarefa antes de qualquer mudança.

## Sempre

- Valide toda entrada externa (corpo, query, parâmetros de rota, cookies, headers usados) com o mecanismo de validação do projeto.
- Regra que envolve banco, dinheiro, estoque ou permissão tem **teste de integração** com banco real, não só unitário.
- Pense em concorrência: o que acontece com duas requisições iguais ao mesmo tempo? Prefira garantias no banco (transação, `UPDATE ... WHERE`, restrições) a checagens no código.
- Erros seguem o formato do projeto e não vazam detalhes internos (stack, SQL, hashes).
- Siga o padrão dos módulos existentes antes de inventar um novo.

## Nunca

- Altere contrato (schemas compartilhados, schema do banco, documentação da API) sem a spec autorizar.
- Logue senha, token, hash ou dado pessoal.
- Confie em valor vindo do cliente para preço, permissão ou dono de um recurso.

## Ao terminar

No PR, liste: o que testou, o que **não** testou, e os pontos de risco para o revisor olhar primeiro.
