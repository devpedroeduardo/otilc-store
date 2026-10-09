import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { ProductEditor } from '@/components/admin/product-editor';
import { canRole } from '@otilc/shared';
import { redirect } from 'next/navigation';
export default async function NewProductPage() {
  const user = await adminApi.session((await cookies()).toString());
  if (!user || !canRole(user.role, 'product:create')) redirect('/admin');
  return (
    <>
      <p className="mono muted">CATÁLOGO</p>
      <h1 className="page-title">Novo produto</h1>
      <ProductEditor role={user.role} create />
    </>
  );
}
