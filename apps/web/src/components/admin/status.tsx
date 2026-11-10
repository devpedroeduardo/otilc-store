/** Rótulos em português e cor de cada status mostrado no painel. */
type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

const ORDER: Record<string, [string, Tone]> = {
  PENDING_PAYMENT: ['Aguardando Pix', 'warn'],
  PAID: ['Pago', 'ok'],
  SHIPPED: ['Enviado', 'info'],
  CANCELED: ['Cancelado', 'err'],
  EXPIRED: ['Expirado', 'muted'],
};
const PRODUCT: Record<string, [string, Tone]> = {
  DRAFT: ['Rascunho', 'muted'],
  ACTIVE: ['À venda', 'ok'],
  RESERVED: ['Reservado', 'warn'],
  SOLD_OUT: ['Vendido', 'info'],
};
const PAYMENT: Record<string, [string, Tone]> = {
  PENDING: ['Pendente', 'warn'],
  APPROVED: ['Aprovado', 'ok'],
  REJECTED: ['Recusado', 'err'],
  CANCELLED: ['Cancelado', 'muted'],
  REFUNDED: ['Estornado', 'info'],
  CHARGED_BACK: ['Contestado', 'err'],
};

export const ORDER_STATUSES = Object.keys(ORDER);
export const PRODUCT_STATUSES = Object.keys(PRODUCT);

export const orderStatusLabel = (s: string) => ORDER[s]?.[0] ?? s;
export const productStatusLabel = (s: string) => PRODUCT[s]?.[0] ?? s;

function Badge({
  entry,
  raw,
  className,
}: {
  entry?: [string, Tone];
  raw: string;
  className?: string;
}) {
  const [label, tone] = entry ?? [raw, 'muted'];
  return (
    <span className={`badge ${tone}${className ? ` ${className}` : ''}`} title={raw}>
      {label}
    </span>
  );
}

export const OrderStatus = ({ status, className }: { status: string; className?: string }) => (
  <Badge entry={ORDER[status]} raw={status} className={className} />
);
export const ProductStatus = ({ status }: { status: string }) => (
  <Badge entry={PRODUCT[status]} raw={status} />
);
export const PaymentStatus = ({ status }: { status: string }) => (
  <Badge entry={PAYMENT[status]} raw={status} />
);

export const adminDate = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Fortaleza',
});

/** Data de exibição; vazio ou inválido vira travessão curto. */
export function formatAdminDate(iso: string): string {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? adminDate.format(d) : '-';
}
