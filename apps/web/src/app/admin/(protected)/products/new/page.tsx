import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { ProductEditor } from '@/components/admin/product-editor';
export default async function NewProductPage() {
  const user = await adminApi.session((await cookies()).toString());
  return (
    <>
      <p className="mono muted">CATÁLOGO</p>
      <h1 className="page-title">Novo produto</h1>
      <ProductEditor role={user?.role ?? 'STAFF'} create />
    </>
  );
}
