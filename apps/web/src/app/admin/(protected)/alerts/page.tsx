import Link from 'next/link';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { AlertActions } from '@/components/admin/alert-actions';
import {
  adminAlertQuerySchema,
  alertGuide,
  formatBRL,
  paymentAlertGuides,
  paymentAlertTypeSchema,
  type AdminAlertQuery,
} from '@otilc/shared';
const situations = [
  ['abertos', 'Abertos'],
  ['resolvidos', 'Resolvidos'],
  ['todos', 'Todos'],
] as const;
const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Fortaleza',
});
function href(query: AdminAlertQuery, patch: Partial<AdminAlertQuery>) {
  const next = { ...query, ...patch };
  const params = new URLSearchParams({ situacao: next.situacao });
  if (next.tipo) params.set('tipo', next.tipo);
  if (next.pagina > 1) params.set('pagina', String(next.pagina));
  return `/admin/alerts?${params}`;
}
export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // O formulário manda `tipo=` vazio quando é "Todos": vazio equivale a ausente.
  const filled = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => v !== ''));
  const parsedQuery = adminAlertQuerySchema.safeParse(filled);
  if (!parsedQuery.success) {
    return (
      <>
        <h1 className="page-title">Alertas</h1>
        <p className="alert error">Os filtros informados são inválidos.</p>
      </>
    );
  }
  const query = parsedQuery.data;
  let page;
  try {
    page = await adminApi.alerts(query, (await cookies()).toString());
  } catch {
    return (
      <>
        <h1 className="page-title">Alertas</h1>
        <p className="alert error">Não foi possível carregar os alertas.</p>
      </>
    );
  }
  return (
    <>
      <p className="mono muted">PAGAMENTOS</p>
      <h1 className="page-title">Alertas</h1>
      <form className="toolbar">
        <label>
          Situação{' '}
          <select name="situacao" defaultValue={query.situacao}>
            {situations.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tipo{' '}
          <select name="tipo" defaultValue={query.tipo ?? ''}>
            <option value="">Todos</option>
            {paymentAlertTypeSchema.options.map((value) => (
              <option key={value} value={value}>
                {paymentAlertGuides[value].title}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-ghost">Filtrar</button>
      </form>
      {!page.items.length ? (
        <p className="empty">Nenhum alerta encontrado.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Tipo</th>
                <th>Pedido</th>
                <th>Pagamento</th>
                <th>O que fazer</th>
                <th>Situação</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((alert) => {
                const guide = alertGuide(alert.type);
                return (
                  <tr key={alert.id}>
                    <td>{dateFormat.format(new Date(alert.createdAt))}</td>
                    <td>{guide.title}</td>
                    <td>
                      <Link href={`/admin/orders/${alert.order.id}`}>#{alert.order.number}</Link>
                    </td>
                    <td>
                      {alert.payment.status} · {formatBRL(alert.payment.amountCents)}
                    </td>
                    <td>{guide.action}</td>
                    <td>
                      {alert.resolvedAt
                        ? `Resolvido em ${dateFormat.format(new Date(alert.resolvedAt))}${
                            alert.resolvedBy ? ` por ${alert.resolvedBy}` : ''
                          }`
                        : 'Aberto'}
                    </td>
                    <td>
                      <AlertActions alert={alert} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {page.totalPages > 1 && (
        <nav className="toolbar" aria-label="Paginação">
          {page.page > 1 ? (
            <Link href={href(query, { pagina: page.page - 1 })}>Anterior</Link>
          ) : (
            <span />
          )}
          <span className="muted">
            Página {page.page} de {page.totalPages}
          </span>
          {page.page < page.totalPages ? (
            <Link href={href(query, { pagina: page.page + 1 })}>Próxima</Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
