import { AdminReveal } from '@/components/view-transition';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { ProductEditor } from '@/components/admin/product-editor';
import { ArrowIcon } from '@/components/icons';
import { canRole } from '@otilc/shared';
import { redirect } from 'next/navigation';
export default async function NewProductPage() {
  const user = await adminApi.session((await cookies()).toString());
  if (!user || !canRole(user.role, 'product:create')) redirect('/admin');
  return (
    <AdminReveal>
      <div>
        <Link href="/admin" className="admin-back">
          <ArrowIcon /> Produtos
        </Link>
        <div className="admin-heading">
          <div>
            <h1 className="page-title">Novo produto</h1>
            <p className="sub">
              Depois de salvar, crie as variações para a peça poder ser vendida.
            </p>
          </div>
        </div>
        <ProductEditor role={user.role} create />
      </div>
    </AdminReveal>
  );
}
