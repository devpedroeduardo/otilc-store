import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { AdminNav } from '@/components/admin/admin-nav';
import { adminApi } from '@/lib/admin-api';
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await adminApi.session((await cookies()).toString());
  if (!session) redirect('/admin/login');
  // O contador é só um aviso: se a lista falhar, o menu aparece sem número.
  const openAlerts = await adminApi
    .alerts({ situacao: 'abertos', porPagina: 1 }, (await cookies()).toString())
    .then((page) => page.total)
    .catch(() => undefined);
  return (
    <>
      <AdminNav user={session} openAlerts={openAlerts} />
      <section className="wrap admin-main">{children}</section>
    </>
  );
}
