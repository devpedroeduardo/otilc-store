import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatBRL } from '@otilc/shared';
import { AddToCart } from '@/components/add-to-cart';
import { Condition } from '@/components/condition';
import { ApiError, getProduct } from '@/lib/api';

export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;

async function load(slug: string) {
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) notFound();
  try {
    return await getProduct(slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const product = await load((await params).slug);
  return {
    title: product.name,
    description: `${product.name}${product.brand ? ` · ${product.brand}` : ''} por ${formatBRL(product.priceCents)}.`,
  };
}

export default async function ProductPage({ params }: { params: Params }) {
  const product = await load((await params).slug);

  return (
    <div className="wrap">
      <Link href="/" className="back mono muted">
        ← Voltar ao catálogo
      </Link>
      <article className="product">
        <div className="gallery">
          {product.images.map((img, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={img.url}
              src={img.url}
              alt={img.alt}
              width={800}
              height={1000}
              loading={i === 0 ? 'eager' : 'lazy'}
            />
          ))}
        </div>
        <div className="info">
          <span className="mono muted">
            {product.category.name}
            {product.brand ? ` · ${product.brand}` : ''}
          </span>
          <h1>{product.name}</h1>
          <span className="big-price">{formatBRL(product.priceCents)}</span>
          <div>
            <span className="mono muted" style={{ display: 'block', marginBottom: 8 }}>
              Condição
            </span>
            <Condition value={product.condition} />
          </div>
          {product.note && <p className="note">“{product.note}”</p>}
          {product.description && <p>{product.description}</p>}
          <AddToCart product={product} />
        </div>
      </article>
    </div>
  );
}
