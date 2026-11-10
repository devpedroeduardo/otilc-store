import { AdminReveal } from '@/components/view-transition';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { formatBRL } from '@otilc/shared';
import { OrderActions } from '@/components/admin/order-actions';
import { OrderStatus, formatAdminDate } from '@/components/admin/status';
import { ArrowIcon, ExternalIcon, MailIcon, PhoneIcon } from '@/components/icons';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await adminApi.order(id, (await cookies()).toString()).catch(() => null);
  if (!order) notFound();
  const whatsapp = order.customerPhone.replace(/\D/g, '');
  return (
    <AdminReveal>
      <div>
        <Link href="/admin/orders" className="admin-back">
          <ArrowIcon /> Pedidos
        </Link>
        <div className="admin-heading">
          <div>
            <h1 className="page-title">Pedido #{order.number}</h1>
            <p className="sub">Criado em {formatAdminDate(order.createdAt)}</p>
          </div>
          <OrderStatus status={order.status} className="lg order-status" />
        </div>

        <div className="detail">
          <div>
            <section className="card-box" aria-labelledby="titulo-itens">
              <header>
                <h2 id="titulo-itens">Itens</h2>
                <span className="muted">
                  {order.items.length} {order.items.length === 1 ? 'peça' : 'peças'}
                </span>
              </header>
              <div className="admin-table-wrap">
                <table className="admin-table" style={{ minWidth: 520 }}>
                  <thead>
                    <tr>
                      <th>Produto</th>
                      <th>Tam.</th>
                      <th>Qtd.</th>
                      <th>Preço</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => (
                      <tr key={item.variantId}>
                        <td>
                          <strong>{item.productName}</strong>
                          <small>{item.sku}</small>
                        </td>
                        <td>{item.size}</td>
                        <td className="num">{item.quantity}</td>
                        <td className="num">{formatBRL(item.unitPriceCents * item.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="sum-row">
                <span>Total</span>
                <span>{formatBRL(order.totalCents)}</span>
              </div>
            </section>
          </div>

          <div>
            <section className="card-box" aria-labelledby="titulo-status">
              <header>
                <h2 id="titulo-status">Andamento</h2>
              </header>
              <div className="body">
                {order.status === 'PENDING_PAYMENT' && (
                  <dl className="kv">
                    <div>
                      <dt>Reserva vence</dt>
                      <dd>{formatAdminDate(order.expiresAt)}</dd>
                    </div>
                  </dl>
                )}
                <OrderActions order={order} />
              </div>
            </section>

            <section className="card-box" aria-labelledby="titulo-cliente">
              <header>
                <h2 id="titulo-cliente">Cliente</h2>
              </header>
              <div className="body">
                <strong style={{ fontSize: 18 }}>{order.customerName}</strong>
                <a className="contact" href={`mailto:${order.customerEmail}`}>
                  <MailIcon /> {order.customerEmail}
                </a>
                {whatsapp && (
                  <a
                    className="contact"
                    href={`https://wa.me/${whatsapp}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <PhoneIcon /> {order.customerPhone}
                    <ExternalIcon className="ext" />
                  </a>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </AdminReveal>
  );
}
