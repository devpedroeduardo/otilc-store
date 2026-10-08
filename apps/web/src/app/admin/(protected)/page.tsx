import Link from 'next/link';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { formatBRL } from '@otilc/shared';
export default async function ProductsPage() {
  let products;
  try {
    products = await adminApi.products((await cookies()).toString());
  } catch {
    return (
      <>
        <h1 className="page-title">Produtos</h1>
        <p className="alert error">Não foi possível carregar os produtos.</p>
      </>
    );
  }
  return (
    <>
      <div className="admin-heading">
        <div>
          <p className="mono muted">CATÁLOGO</p>
          <h1 className="page-title">Produtos</h1>
        </div>
        <Link className="btn btn-solid" href="/admin/products/new">
          Novo produto
        </Link>
      </div>
      {products.length === 0 ? (
        <p className="empty">Nenhum produto cadastrado.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Status</th>
                <th>Preço</th>
                <th>Estoque</th>
                <th>Reservado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const stock = product.variants.reduce((sum, variant) => sum + variant.stock, 0);
                const reserved = product.variants.reduce(
                  (sum, variant) => sum + variant.reserved,
                  0,
                );
                return (
                  <tr key={product.id}>
                    <td>
                      <strong>{product.name}</strong>
                      <small>{product.slug}</small>
                    </td>
                    <td>{product.status}</td>
                    <td>{formatBRL(product.priceCents)}</td>
                    <td>{stock}</td>
                    <td>{reserved}</td>
                    <td>
                      <Link href={`/admin/products/${product.id}`}>Abrir</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
