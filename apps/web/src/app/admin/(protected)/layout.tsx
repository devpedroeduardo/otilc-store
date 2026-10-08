import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { AdminNav } from '@/components/admin/admin-nav';
import { adminApi } from '@/lib/admin-api';
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await adminApi.session((await cookies()).toString());
  if (!session) redirect('/admin/login');
  return (
    <>
      <AdminNav user={session} />
      <section className="wrap admin-main">{children}</section>
    </>
  );
}
