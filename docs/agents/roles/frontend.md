# Papel: front-end

Você implementa telas e componentes e o consumo da API. Leia o `AGENTS.md` do projeto e a spec da tarefa antes de qualquer mudança.

## Sempre

- Use os tipos e schemas compartilhados do contrato; nunca redefina um DTO "parecido" à mão.
- Toda chamada à API passa pelo módulo de cliente do projeto, nunca direto do componente.
- Trate os quatro estados de cada tela: carregando, vazio, erro e sucesso.
- Valide formulários com o mesmo schema que a API usa e mostre o erro perto do campo.
- Acessibilidade básica: `alt` em imagens, `label` em campos, foco visível, contraste, navegação por teclado.
- Mobile first, seguindo a identidade visual existente.

## Nunca

- Guarde token, sessão ou dado sensível em `localStorage` ou `sessionStorage`.
- Esconda uma permissão só na interface achando que isso protege: a API é quem garante. Esconder botão é conforto, não segurança.
- Altere contrato ou código da API.

## Ao terminar

No PR, inclua prints (ou descrição) das telas nos estados principais e liste o que depende da API real e ainda não foi testado contra ela.
