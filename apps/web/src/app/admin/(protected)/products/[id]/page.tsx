import { AdminReveal } from '@/components/view-transition';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ProductEditor } from '@/components/admin/product-editor';
import { ArrowIcon, ExternalIcon } from '@/components/icons';
import { adminApi } from '@/lib/admin-api';
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [product, user] = await Promise.all([
    adminApi.product(id, (await cookies()).toString()).catch(() => null),
    adminApi.session((await cookies()).toString()),
  ]);
  if (!product || !user) notFound();
  return (
    <AdminReveal>
      <div>
        <Link href="/admin" className="admin-back">
          <ArrowIcon /> Produtos
        </Link>
        <div className="admin-heading">
          <div>
            <h1 className="page-title">Editar produto</h1>
            <p className="sub">{product.name}</p>
          </div>
          <Link
            href={`/produto/${product.slug}`}
            className="btn btn-ghost btn-sm"
            target="_blank"
            rel="noopener"
          >
            <ExternalIcon /> Ver na loja
          </Link>
        </div>
        <ProductEditor product={product} role={user.role} />
      </div>
    </AdminReveal>
  );
}
