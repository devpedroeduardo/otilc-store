import Link from 'next/link';
import { formatBRL, type ProductListItemDto } from '@otilc/shared';
import { Condition } from './condition';
import { ArrowIcon } from './icons';
import { ViewTransition } from './view-transition';

const STATUS_LABEL: Record<string, string> = { RESERVED: 'Reservado', SOLD_OUT: 'Vendido' };

/** Número da peça no drop, vindo do slug (`07-casaco` vira `Nº 07`). */
export function pieceNumber(slug: string): string | null {
  const match = /^(\d{1,3})-/.exec(slug);
  return match ? `Nº ${match[1]}` : null;
}

export function ProductCard({
  product,
  priority,
  wide,
  morph = true,
}: {
  product: ProductListItemDto;
  priority?: boolean;
  wide?: boolean;
  /** Foto que vira a foto grande do produto ao navegar. Desligue onde o card é só ilustração. */
  morph?: boolean;
}) {
  const out = product.status !== 'ACTIVE';
  const num = pieceNumber(product.slug);
  return (
    <Link
      href={`/produto/${product.slug}`}
      className={`card${out ? ' out' : ''}${wide ? ' wide' : ''}`}
    >
      <div className="shot">
        {product.image && (
          <ViewTransition
            name={morph ? `photo-${product.slug}` : undefined}
            share="morph"
            default="none"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={product.image.url}
              alt={product.image.alt}
              width={800}
              height={1000}
              loading={priority ? 'eager' : 'lazy'}
            />
          </ViewTransition>
        )}
        {out && (
          <span className="pill center">{STATUS_LABEL[product.status] ?? 'Indisponível'}</span>
        )}
        {!out && product.featured && <span className="pill">Destaque</span>}
        {num && <span className="num">{num}</span>}
        <span className="see" aria-hidden="true">
          Ver peça <ArrowIcon />
        </span>
      </div>
      <div className="meta">
        <span className="brand-line">{product.brand ?? product.category.name}</span>
        <h3>{product.name}</h3>
        <div className="row">
          <span className="price">{formatBRL(product.priceCents)}</span>
          <Condition value={product.condition} />
        </div>
        {product.sizes.length > 0 && (
          <span className="size-tags" aria-label={`Tamanhos: ${product.sizes.join(', ')}`}>
            {product.sizes.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </span>
        )}
      </div>
    </Link>
  );
}
