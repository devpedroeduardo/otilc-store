import Link from 'next/link';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { adminOrderQuerySchema, formatBRL } from '@otilc/shared';
const statuses = ['PENDING_PAYMENT', 'PAID', 'CANCELED', 'EXPIRED', 'SHIPPED'];
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
  let page;
  try {
    page = await adminApi.orders(status, (await cookies()).toString());
  } catch {
    return (
      <>
        <h1 className="page-title">Pedidos</h1>
        <p className="alert error">Não foi possível carregar os pedidos.</p>
      </>
    );
  }
  return (
    <>
      <p className="mono muted">VENDAS</p>
      <h1 className="page-title">Pedidos</h1>
      <form className="toolbar">
        <label>
          Status{' '}
          <select name="status" defaultValue={status ?? ''}>
            <option value="">Todos</option>
            {statuses.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button className="btn btn-ghost">Filtrar</button>
      </form>
      {!page.items.length ? (
        <p className="empty">Nenhum pedido encontrado.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Status</th>
                <th>Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((order) => (
                <tr key={order.id}>
                  <td>#{order.number}</td>
                  <td>{order.customerName}</td>
                  <td>{order.status}</td>
                  <td>{formatBRL(order.totalCents)}</td>
                  <td>
                    <Link href={`/admin/orders/${order.id}`}>Detalhe</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
