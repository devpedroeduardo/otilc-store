import Link from 'next/link';
import { formatBRL, type ProductListItemDto } from '@otilc/shared';
import { Condition } from './condition';

const STATUS_LABEL: Record<string, string> = { RESERVED: 'Reservado', SOLD_OUT: 'Vendido' };

export function ProductCard({
  product,
  priority,
}: {
  product: ProductListItemDto;
  priority?: boolean;
}) {
  const out = product.status !== 'ACTIVE';
  return (
    <Link href={`/produto/${product.slug}`} className={`card${out ? ' out' : ''}`}>
      <div className="shot">
        {product.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image.url}
            alt={product.image.alt}
            width={800}
            height={1000}
            loading={priority ? 'eager' : 'lazy'}
          />
        )}
        {out && (
          <span className="pill center">{STATUS_LABEL[product.status] ?? 'Indisponível'}</span>
        )}
        {!out && product.featured && <span className="pill">Destaque</span>}
      </div>
      <div className="meta">
        <span className="mono muted">{product.brand ?? product.category.name}</span>
        <h3>{product.name}</h3>
        <div className="row">
          <span className="price">{formatBRL(product.priceCents)}</span>
          <Condition value={product.condition} />
        </div>
        {product.sizes.length > 0 && (
          <span className="mono muted">Tam. {product.sizes.join(' · ')}</span>
        )}
      </div>
    </Link>
  );
}
