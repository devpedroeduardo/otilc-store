import { formatBRL } from '@otilc/shared';

export interface OrderConfirmationInput {
  number: number;
  customerName: string;
  totalCents: number;
  items: { productName: string; size: string; quantity: number; unitPriceCents: number }[];
  /** Origem da loja (`WEB_ORIGIN`). */
  storeUrl: string;
  /** `EMAIL_REPLY_TO`; sem ele, o e-mail sai sem a linha de contato. */
  contact: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const NEXT_STEPS_TITLE = 'Próximos passos';
const NEXT_STEPS =
  'Recebemos o pagamento e o seu pedido já entrou na nossa fila de separação. ' +
  'Vamos separar e embalar os itens com cuidado. ' +
  'Quando o pedido for enviado, você recebe um novo e-mail avisando.';
// Só faz sentido com reply-to configurado.
const NEXT_STEPS_REPLY = 'Se tiver alguma dúvida, é só responder este e-mail.';

/** Escapa texto para HTML. Todo dado do pedido passa por aqui antes de entrar no corpo. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const cell = 'padding:8px;border-bottom:1px solid #e5e5e5;text-align:left;';
const cellRight = 'padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;';

/**
 * E-mail de confirmação do pedido pago (spec-036): assunto, HTML com estilo inline e versão texto,
 * em pt-BR. Sem imagem remota e sem pixel de rastreio.
 */
export function renderOrderConfirmation(input: OrderConfirmationInput): RenderedEmail {
  const subject = `Pedido nº ${input.number} confirmado`;
  const nextSteps = input.contact ? `${NEXT_STEPS} ${NEXT_STEPS_REPLY}` : NEXT_STEPS;
  const total = formatBRL(input.totalCents);

  const rows = input.items
    .map(
      (item) =>
        `<tr><td style="${cell}">${escapeHtml(item.productName)}</td>` +
        `<td style="${cell}">${escapeHtml(item.size)}</td>` +
        `<td style="${cellRight}">${item.quantity}</td>` +
        `<td style="${cellRight}">${escapeHtml(formatBRL(item.unitPriceCents))}</td></tr>`,
    )
    .join('');
  const store = escapeHtml(input.storeUrl);
  const contactHtml = input.contact
    ? `<p style="margin:16px 0 0;color:#555;font-size:13px;">Contato: <a href="mailto:${escapeHtml(input.contact)}" style="color:#111;">${escapeHtml(input.contact)}</a></p>`
    : '';

  const html = [
    '<!doctype html>',
    '<html lang="pt-BR"><head><meta charset="utf-8"><title>',
    escapeHtml(subject),
    '</title></head>',
    '<body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111;">',
    '<div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;">',
    '<p style="margin:0 0 16px;font-size:14px;letter-spacing:2px;font-weight:bold;">OTILC</p>',
    `<h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(subject)}</h1>`,
    `<p style="margin:0 0 16px;">Olá, ${escapeHtml(input.customerName)}! Recebemos o pagamento do seu pedido.</p>`,
    '<table style="width:100%;border-collapse:collapse;font-size:14px;">',
    `<thead><tr><th style="${cell}">Produto</th><th style="${cell}">Tamanho</th>`,
    `<th style="${cellRight}">Qtd.</th><th style="${cellRight}">Preço</th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `<tfoot><tr><td colspan="3" style="${cell}font-weight:bold;">Total</td>`,
    `<td style="${cellRight}font-weight:bold;">${escapeHtml(total)}</td></tr></tfoot>`,
    '</table>',
    `<h2 style="margin:24px 0 8px;font-size:16px;">${NEXT_STEPS_TITLE}</h2>`,
    `<p style="margin:0 0 16px;">${escapeHtml(nextSteps)}</p>`,
    `<p style="margin:0;"><a href="${store}" style="color:#111;">Visitar a loja</a></p>`,
    contactHtml,
    '</div></body></html>',
  ].join('');

  const text = [
    subject,
    '',
    `Olá, ${input.customerName}! Recebemos o pagamento do seu pedido.`,
    '',
    ...input.items.map(
      (item) =>
        `- ${item.productName} (tamanho ${item.size}) · ${item.quantity} × ${formatBRL(item.unitPriceCents)}`,
    ),
    '',
    `Total: ${total}`,
    '',
    NEXT_STEPS_TITLE,
    nextSteps,
    '',
    `Loja: ${input.storeUrl}`,
    ...(input.contact ? [`Contato: ${input.contact}`] : []),
  ].join('\n');

  return { subject, html, text };
}
