import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatBRL } from '@otilc/shared';
import { AddToCart } from '@/components/add-to-cart';
import { Condition, conditionLabel } from '@/components/condition';
import { Gallery } from '@/components/gallery';
import { BoltIcon, ClockIcon, ShieldIcon, SparkIcon } from '@/components/icons';
import { ProductCard, pieceNumber } from '@/components/product-card';
import { ApiError, getProduct, getProducts } from '@/lib/api';
import { PageTransition, ViewTransition } from '@/components/view-transition';

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
  // "Mais peças" é um extra: se a lista falhar, a página do produto continua de pé.
  const related = await getProducts({ categoria: product.category.slug, pagina: 1 })
    .then((page) =>
      page.items.filter((p) => p.slug !== product.slug && p.status === 'ACTIVE').slice(0, 4),
    )
    .catch(() => []);
  const num = pieceNumber(product.slug);
  const out = product.status !== 'ACTIVE';

  return (
    <PageTransition>
      <div>
        <div className="wrap">
          <ol className="crumbs" aria-label="Você está em">
            <li>
              <Link href="/">Loja</Link>
            </li>
            <li>
              <Link href={`/?categoria=${product.category.slug}#pecas`}>
                {product.category.name}
              </Link>
            </li>
            <li aria-current="page">{product.name}</li>
          </ol>
          <article className="product">
            <Gallery images={product.images} out={out} slug={product.slug} />
            <div className="info">
              <div className="kicker">
                <span>{product.brand ?? product.category.name}</span>
                {num && <span className="mono">{num}</span>}
              </div>
              <h1>{product.name}</h1>
              <div className="price-row">
                <span className="big-price">{formatBRL(product.priceCents)}</span>
                <span className="unique">
                  <SparkIcon /> Peça única
                </span>
              </div>
              <div className="cond-box">
                <div className="label">
                  <span className="muted">Condição</span>
                  <strong>{conditionLabel(product.condition)}</strong>
                </div>
                <Condition value={product.condition} large />
              </div>
              {product.note && <p className="note">“{product.note}”</p>}
              {product.description && <p className="desc">{product.description}</p>}
              <AddToCart product={product} />
              <ul className="perks">
                <li>
                  <ClockIcon />
                  <span>
                    <strong>Reserva de 30 minutos</strong>
                    Ao finalizar o pedido, a peça sai da loja enquanto você paga.
                  </span>
                </li>
                <li>
                  <BoltIcon />
                  <span>
                    <strong>Pix com confirmação automática</strong>A página confirma o pagamento
                    sozinha, sem comprovante.
                  </span>
                </li>
                <li>
                  <ShieldIcon />
                  <span>
                    <strong>Pagamento pelo Mercado Pago</strong>O valor é calculado pela loja no
                    servidor.
                  </span>
                </li>
              </ul>
            </div>
          </article>
        </div>

        {related.length > 0 && (
          <section className="related section" aria-labelledby="titulo-mais">
            <div className="wrap">
              <div className="section-head">
                <h2 id="titulo-mais">
                  Mais <em className="chrome-text">{product.category.name.toLowerCase()}</em>
                </h2>
                <Link href={`/?categoria=${product.category.slug}#pecas`} className="btn btn-ghost">
                  Ver todos
                </Link>
              </div>
              <div className="grid" style={{ paddingTop: 0 }}>
                {related.map((p) => (
                  <ViewTransition key={p.slug}>
                    <ProductCard product={p} />
                  </ViewTransition>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </PageTransition>
  );
}
