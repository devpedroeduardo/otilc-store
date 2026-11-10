import { AdminReveal } from '@/components/view-transition';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { AlertActions } from '@/components/admin/alert-actions';
import { PaymentStatus } from '@/components/admin/status';
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
    <AdminReveal>
      <div>
        <div className="admin-heading">
          <div>
            <span className="muted">Pagamentos</span>
            <h1 className="page-title">Alertas</h1>
            <p className="sub">
              Situações do Pix que pedem uma ação sua. Cada alerta diz o que fazer.
            </p>
          </div>
        </div>
        <nav className="filters" aria-label="Situação">
          {situations.map(([value, label]) => (
            <Link
              key={value}
              href={href(query, { situacao: value, pagina: 1 })}
              className="chip"
              aria-current={query.situacao === value ? 'page' : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form className="filter-form">
          <input type="hidden" name="situacao" value={query.situacao} />
          <label>
            Tipo de alerta
            <select name="tipo" defaultValue={query.tipo ?? ''}>
              <option value="">Todos</option>
              {paymentAlertTypeSchema.options.map((value) => (
                <option key={value} value={value}>
                  {paymentAlertGuides[value].title}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-ghost btn-sm">Filtrar</button>
        </form>
        {!page.items.length ? (
          <div className="empty-state">
            <span className="badge ok lg">Tudo em dia</span>
            <h2>Nenhum alerta encontrado</h2>
            <p>Quando um pagamento precisar de atenção, ele aparece aqui com o passo a passo.</p>
          </div>
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
                      <td className="num">{dateFormat.format(new Date(alert.createdAt))}</td>
                      <td>
                        <strong>{guide.title}</strong>
                      </td>
                      <td>
                        <Link href={`/admin/orders/${alert.order.id}`}>#{alert.order.number}</Link>
                      </td>
                      <td>
                        <PaymentStatus status={alert.payment.status} />
                        <small className="num">{formatBRL(alert.payment.amountCents)}</small>
                      </td>
                      <td style={{ maxWidth: 320 }}>{guide.action}</td>
                      <td>
                        {alert.resolvedAt ? (
                          <>
                            <span className="badge ok">Resolvido</span>
                            <small>
                              {dateFormat.format(new Date(alert.resolvedAt))}
                              {alert.resolvedBy ? ` por ${alert.resolvedBy}` : ''}
                            </small>
                          </>
                        ) : (
                          <span className="badge err">Aberto</span>
                        )}
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
          <nav
            className="filters"
            aria-label="Paginação"
            style={{ justifyContent: 'space-between', marginTop: 16 }}
          >
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
      </div>
    </AdminReveal>
  );
}
