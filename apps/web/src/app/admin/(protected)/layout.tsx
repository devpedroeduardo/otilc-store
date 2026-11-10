import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { AdminNav } from '@/components/admin/admin-nav';
import { adminApi } from '@/lib/admin-api';
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await adminApi.session((await cookies()).toString());
  if (!session) redirect('/admin/login');
  const cookie = (await cookies()).toString();
  // Os contadores são só aviso: se uma lista falhar, o menu aparece sem o número.
  const count = (load: () => Promise<{ total: number }>) =>
    Promise.resolve()
      .then(load)
      .then((page) => page.total)
      .catch(() => undefined);
  const [openAlerts, pendingOrders] = await Promise.all([
    count(() => adminApi.alerts({ situacao: 'abertos', porPagina: 1 }, cookie)),
    count(() => adminApi.orders('PENDING_PAYMENT', cookie)),
  ]);
  return (
    <div className="admin-shell">
      <AdminNav user={session} openAlerts={openAlerts} pendingOrders={pendingOrders} />
      <main id="conteudo" className="admin-main">
        {children}
      </main>
    </div>
  );
}
