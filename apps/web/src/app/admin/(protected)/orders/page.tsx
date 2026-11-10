import { AdminReveal } from '@/components/view-transition';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { adminOrderQuerySchema, formatBRL } from '@otilc/shared';
import { ArrowIcon } from '@/components/icons';
import {
  ORDER_STATUSES,
  OrderStatus,
  formatAdminDate,
  orderStatusLabel,
} from '@/components/admin/status';

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const parsedQuery = adminOrderQuerySchema.safeParse(await searchParams);
  if (!parsedQuery.success) {
    return (
      <>
        <h1 className="page-title">Pedidos</h1>
        <p className="alert error">O filtro de status informado é inválido.</p>
      </>
    );
  }
  const status = parsedQuery.data.status;
  const cookie = (await cookies()).toString();
  let page;
  try {
    page = await adminApi.orders(status, cookie);
  } catch {
    return (
      <>
        <h1 className="page-title">Pedidos</h1>
        <p className="alert error">Não foi possível carregar os pedidos.</p>
      </>
    );
  }
  // Contagem por status para os filtros. Uma falha só esconde o número daquele filtro.
  const counts = await Promise.all(
    [undefined, ...ORDER_STATUSES].map((s) =>
      Promise.resolve()
        .then(() => adminApi.orders(s, cookie))
        .then((p) => p.total)
        .catch(() => undefined),
    ),
  );
  const [all, ...perStatus] = counts;
  const countOf = (s: string) => perStatus[ORDER_STATUSES.indexOf(s)];

  return (
    <AdminReveal>
      <div>
        <div className="admin-heading">
          <div>
            <span className="muted">Vendas</span>
            <h1 className="page-title">Pedidos</h1>
          </div>
        </div>

        <dl className="stats">
          <div className="stat lead">
            <dt>Aguardando Pix</dt>
            <dd>{countOf('PENDING_PAYMENT') ?? '-'}</dd>
          </div>
          <div className="stat">
            <dt>Pagos, a enviar</dt>
            <dd>{countOf('PAID') ?? '-'}</dd>
          </div>
          <div className="stat">
            <dt>Enviados</dt>
            <dd>{countOf('SHIPPED') ?? '-'}</dd>
          </div>
          <div className="stat">
            <dt>Pedidos no total</dt>
            <dd>{all ?? '-'}</dd>
          </div>
        </dl>

        <nav className="filters" aria-label="Filtrar por status">
          <Link href="/admin/orders" className="chip" aria-current={!status ? 'page' : undefined}>
            Todos {all !== undefined && <small>{all}</small>}
          </Link>
          {ORDER_STATUSES.map((s, i) => (
            <Link
              key={s}
              href={`/admin/orders?status=${s}`}
              className="chip"
              aria-current={status === s ? 'page' : undefined}
            >
              {orderStatusLabel(s)} {perStatus[i] !== undefined && <small>{perStatus[i]}</small>}
            </Link>
          ))}
        </nav>

        {!page.items.length ? (
          <div className="empty-state">
            <h2>Nenhum pedido encontrado</h2>
            <p>Quando alguém finalizar uma compra, o pedido aparece aqui.</p>
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Criado em</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((order) => (
                  <tr key={order.id}>
                    <td className="num">#{order.number}</td>
                    <td>
                      <strong>{order.customerName}</strong>
                      <small>
                        {order.itemCount} {order.itemCount === 1 ? 'item' : 'itens'}
                      </small>
                    </td>
                    <td className="num">{formatAdminDate(order.createdAt)}</td>
                    <td>
                      <OrderStatus status={order.status} />
                    </td>
                    <td className="num">{formatBRL(order.totalCents)}</td>
                    <td className="go">
                      <Link href={`/admin/orders/${order.id}`}>
                        Detalhe <ArrowIcon />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminReveal>
  );
}
