import { AdminReveal } from '@/components/view-transition';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { canRole, formatBRL } from '@otilc/shared';
import { ArrowIcon, BoxIcon, PlusIcon } from '@/components/icons';
import { PRODUCT_STATUSES, ProductStatus, productStatusLabel } from '@/components/admin/status';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const cookie = (await cookies()).toString();
  const { status: rawStatus } = await searchParams;
  const status = PRODUCT_STATUSES.includes(rawStatus ?? '') ? rawStatus : undefined;
  let products;
  const user = await adminApi.session(cookie);
  try {
    products = await adminApi.products(cookie);
  } catch {
    return (
      <>
        <h1 className="page-title">Produtos</h1>
        <p className="alert error">Não foi possível carregar os produtos.</p>
      </>
    );
  }
  const totals = (list: typeof products) =>
    list.reduce(
      (acc, p) => {
        const stock = p.variants.reduce((sum, v) => sum + v.stock, 0);
        const reserved = p.variants.reduce((sum, v) => sum + v.reserved, 0);
        acc.reserved += reserved;
        if (p.status === 'ACTIVE' && stock - reserved > 0) {
          acc.forSale += 1;
          acc.value += p.priceCents * (stock - reserved);
        }
        return acc;
      },
      { forSale: 0, reserved: 0, value: 0 },
    );
  const summary = totals(products);
  const byStatus = (s: string) => products.filter((p) => p.status === s).length;
  const shown = status ? products.filter((p) => p.status === status) : products;

  return (
    <AdminReveal>
      <div>
        <div className="admin-heading">
          <div>
            <span className="muted">Catálogo</span>
            <h1 className="page-title">Produtos</h1>
          </div>
          {user && canRole(user.role, 'product:create') && (
            <Link className="btn btn-solid" href="/admin/products/new">
              <PlusIcon /> Novo produto
            </Link>
          )}
        </div>

        <dl className="stats">
          <div className="stat lead">
            <dt>Valor à venda</dt>
            <dd>{formatBRL(summary.value)}</dd>
          </div>
          <div className="stat">
            <dt>Peças cadastradas</dt>
            <dd>{products.length}</dd>
          </div>
          <div className="stat">
            <dt>Disponíveis na loja</dt>
            <dd>{summary.forSale}</dd>
          </div>
          <div className="stat">
            <dt>Unidades reservadas</dt>
            <dd>{summary.reserved}</dd>
          </div>
        </dl>

        <nav className="filters" aria-label="Filtrar por status">
          <Link href="/admin" className="chip" aria-current={!status ? 'page' : undefined}>
            Todos <small>{products.length}</small>
          </Link>
          {PRODUCT_STATUSES.map((s) => (
            <Link
              key={s}
              href={`/admin?status=${s}`}
              className="chip"
              aria-current={status === s ? 'page' : undefined}
            >
              {productStatusLabel(s)} <small>{byStatus(s)}</small>
            </Link>
          ))}
        </nav>

        {shown.length === 0 ? (
          <div className="empty-state">
            <h2>Nenhum produto aqui</h2>
            <p>
              {status
                ? 'Nenhum produto com esse status. Escolha outro filtro.'
                : 'Cadastre a primeira peça para ela aparecer na loja.'}
            </p>
          </div>
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
                  <th>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((product) => {
                  const stock = product.variants.reduce((sum, variant) => sum + variant.stock, 0);
                  const reserved = product.variants.reduce(
                    (sum, variant) => sum + variant.reserved,
                    0,
                  );
                  const free = stock > 0 ? (stock - reserved) / stock : 0;
                  const image = product.images[0];
                  return (
                    <tr key={product.id}>
                      <td>
                        <div className="prod-cell">
                          {image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="thumb" src={image.url} alt="" width={44} height={55} />
                          ) : (
                            <span className="thumb blank">
                              <BoxIcon />
                            </span>
                          )}
                          <span>
                            <strong>{product.name}</strong>
                            <small>
                              {product.category.name} · {product.slug}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <ProductStatus status={product.status} />
                      </td>
                      <td className="num">{formatBRL(product.priceCents)}</td>
                      <td>
                        <div className="stock">
                          <span className="num">{stock}</span>
                          <span className="meter" aria-hidden="true">
                            <i
                              className={reserved > 0 ? 'warn' : undefined}
                              style={{ width: `${Math.round(free * 100)}%` }}
                            />
                          </span>
                        </div>
                      </td>
                      <td className="num">{reserved}</td>
                      <td className="go">
                        <Link href={`/admin/products/${product.id}`}>
                          Abrir <ArrowIcon />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminReveal>
  );
}
