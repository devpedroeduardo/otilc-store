import { formatBRL } from '@otilc/shared';
import { escapeHtml, renderOrderConfirmation } from './order-confirmation.template';

const input = {
  number: 42,
  customerName: 'Ana Souza',
  totalCents: 25980,
  items: [
    { productName: 'Camiseta Preta', size: 'M', quantity: 2, unitPriceCents: 9990 },
    { productName: 'Boné Veja Além', size: 'Único', quantity: 1, unitPriceCents: 6000 },
  ],
  storeUrl: 'https://loja.example.test',
  contact: 'atendimento@example.com',
};

describe('renderOrderConfirmation (spec-036)', () => {
  it('assunto com o número do pedido', () => {
    expect(renderOrderConfirmation(input).subject).toBe('Pedido nº 42 confirmado');
  });

  it('HTML e texto trazem cada item, o total via formatBRL, o link da loja e os próximos passos', () => {
    const { html, text } = renderOrderConfirmation(input);
    for (const body of [html, text]) {
      expect(body).toContain('Pedido nº 42 confirmado');
      expect(body).toContain('Ana Souza');
      expect(body).toContain('Camiseta Preta');
      expect(body).toContain('Boné Veja Além');
      expect(body).toContain('Único');
      expect(body).toContain(formatBRL(9990));
      expect(body).toContain(formatBRL(6000));
      expect(body).toContain(formatBRL(25980));
      expect(body).toContain('https://loja.example.test');
      expect(body).toContain('Próximos passos');
      expect(body).toContain('fila de separação');
    }
    expect(html).toContain('href="https://loja.example.test"');
    expect(text).toContain(`- Camiseta Preta (tamanho M) · 2 × ${formatBRL(9990)}`);
    expect(text).toContain(`Total: ${formatBRL(25980)}`);
  });

  it('com contato: reply-to no rodapé e a frase de responder o e-mail', () => {
    const { html, text } = renderOrderConfirmation(input);
    for (const body of [html, text]) {
      expect(body).toContain('atendimento@example.com');
      expect(body).toContain('é só responder este e-mail');
    }
    expect(html).toContain('href="mailto:atendimento@example.com"');
  });

  it('sem contato: nem linha de contato nem a frase de responder', () => {
    const { html, text } = renderOrderConfirmation({ ...input, contact: null });
    for (const body of [html, text]) {
      expect(body).not.toContain('Contato');
      expect(body).not.toContain('mailto:');
      expect(body).not.toContain('responder este e-mail');
    }
  });

  it('dados do pedido saem escapados no HTML', () => {
    const { html } = renderOrderConfirmation({
      ...input,
      customerName: '<script>alert("x")</script>',
      items: [
        {
          productName: 'Camiseta "A" & <b>B</b>',
          size: "<img src='x'>",
          quantity: 1,
          unitPriceCents: 100,
        },
      ],
      storeUrl: 'https://loja.example.test/"><script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('Camiseta &quot;A&quot; &amp; &lt;b&gt;B&lt;/b&gt;');
    expect(html).toContain('&lt;img src=&#39;x&#39;&gt;');
  });

  it('sem imagem remota nem pixel de rastreio', () => {
    const { html } = renderOrderConfirmation(input);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/url\(/i);
  });

  it('escapeHtml cobre os cinco caracteres especiais', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
