import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ProductEditor } from '@/components/admin/product-editor';
import { adminApi } from '@/lib/admin-api';
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [product, user] = await Promise.all([
    adminApi.product(id, (await cookies()).toString()).catch(() => null),
    adminApi.session((await cookies()).toString()),
  ]);
  if (!product || !user) notFound();
  return (
    <>
      <p className="mono muted">PRODUTO · {product.id}</p>
      <h1 className="page-title">Editar produto</h1>
      <ProductEditor product={product} role={user.role} />
    </>
  );
}
