import Link from 'next/link';
import {
  catalogSortSchema,
  formatBRL,
  type CatalogSort,
  type ProductListItemDto,
} from '@otilc/shared';
import { ArrowIcon } from '@/components/icons';
import { ProductCard } from '@/components/product-card';
import { getCategories, getProducts } from '@/lib/api';
import { PageTransition, ViewTransition } from '@/components/view-transition';
import { LiveEye } from '@/components/live-eye';

export const dynamic = 'force-dynamic';

const SORTS: { value: CatalogSort; label: string }[] = [
  { value: 'destaque', label: 'Destaques' },
  { value: 'novidades', label: 'Novidades' },
  { value: 'menor-preco', label: 'Menor preço' },
  { value: 'maior-preco', label: 'Maior preço' },
];

type Search = Promise<{ categoria?: string; ordem?: string }>;

export default async function Home({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const ordem = catalogSortSchema.safeParse(params.ordem).data ?? 'destaque';
  const categoria =
    params.categoria && /^[a-z0-9-]{1,40}$/.test(params.categoria) ? params.categoria : undefined;

  const [categories, catalog, all] = await Promise.all([
    getCategories(),
    getProducts({ categoria, ordem, pagina: 1 }),
    // O topo e a faixa mostram o drop inteiro, mesmo com um filtro aplicado.
    categoria || ordem !== 'destaque'
      ? getProducts({ ordem: 'destaque', pagina: 1 })
      : Promise.resolve(null),
  ]);
  const drop = all ?? catalog;
  const complete = drop.total <= drop.items.length;
  const available = drop.items.filter((p) => p.status === 'ACTIVE').length;
  const cheapest = drop.items
    .filter((p) => p.status === 'ACTIVE')
    .reduce<number | null>(
      (min, p) => (min === null || p.priceCents < min ? p.priceCents : min),
      null,
    );
  const activeCategory = categories.find((c) => c.slug === categoria);

  const href = (next: { categoria?: string; ordem?: CatalogSort }) => {
    const qs = new URLSearchParams();
    const c = 'categoria' in next ? next.categoria : categoria;
    const o = next.ordem ?? ordem;
    if (c) qs.set('categoria', c);
    if (o !== 'destaque') qs.set('ordem', o);
    const s = qs.toString();
    // Sem âncora: o filtro troca a grade no lugar (scroll={false}) e os cards se reorganizam.
    return s ? `/?${s}` : '/';
  };

  const facts = [
    <>
      <strong>{drop.total}</strong> peças no drop
    </>,
    complete ? (
      <>
        <strong>{available}</strong> disponíveis agora
      </>
    ) : null,
    <>Uma unidade de cada</>,
    cheapest !== null ? (
      <>
        A partir de <strong>{formatBRL(cheapest)}</strong>
      </>
    ) : null,
    <>Pix com confirmação automática</>,
    <>Reserva de 30 minutos no pedido</>,
  ].filter(Boolean);

  return (
    <PageTransition>
      <div>
        <section className="hero" aria-labelledby="titulo-hero">
          <div className="wrap">
            <div className="hero-copy">
              <span className="drop-tag">
                <span className="dot" aria-hidden="true" />
                Drop 00 no ar
              </span>
              <h1 id="titulo-hero">
                Veja <em className="chrome-text">além.</em>
              </h1>
              <p className="lede">
                Streetwear seminovo, garimpado peça por peça. Cada item tem uma unidade só, com a
                condição medida de 0 a 10 e pagamento por Pix.
              </p>
              <div className="hero-actions">
                <a href="#pecas" className="btn btn-solid">
                  Ver as peças <ArrowIcon />
                </a>
                <a href="#como-comprar" className="btn btn-ghost">
                  Como comprar
                </a>
              </div>
            </div>

            <div className="hero-eye">
              <LiveEye variant="hero" />
            </div>
          </div>
        </section>

        <div className="ticker" aria-label="Sobre o drop">
          <div className="ticker-track">
            {[0, 1].map((copy) => (
              <ul key={copy} aria-hidden={copy === 1 ? true : undefined}>
                {[...facts, ...facts].map((fact, i) => (
                  <li key={i}>{fact}</li>
                ))}
              </ul>
            ))}
          </div>
        </div>

        <section className="wrap section" id="pecas" aria-labelledby="titulo-catalogo">
          <div className="section-head">
            <h2 id="titulo-catalogo">
              {activeCategory ? activeCategory.name : 'As peças'}
              <span className="count">{catalog.total}</span>
            </h2>
            <p>Peça vendida continua na grade em cinza, para você ver o que já passou por aqui.</p>
          </div>
          <div className="toolbar">
            <nav className="chips" aria-label="Categorias">
              <Link
                scroll={false}
                href={href({ categoria: undefined })}
                className="chip"
                aria-current={!categoria ? 'page' : undefined}
              >
                Tudo
              </Link>
              {categories.map((c) => (
                <Link
                  key={c.slug}
                  scroll={false}
                  href={href({ categoria: c.slug })}
                  className="chip"
                  aria-current={categoria === c.slug ? 'page' : undefined}
                >
                  {c.name}
                </Link>
              ))}
            </nav>
            <nav className="sort" aria-label="Ordenar">
              {SORTS.map((s) => (
                <Link
                  key={s.value}
                  scroll={false}
                  href={href({ ordem: s.value })}
                  aria-current={ordem === s.value ? 'true' : undefined}
                >
                  {s.label}
                </Link>
              ))}
            </nav>
          </div>

          {catalog.items.length === 0 ? (
            <div className="empty-state">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="brand-eye-static"
                src="/brand/eye.webp"
                alt=""
                width={900}
                height={712}
              />
              <h2>Nada por aqui ainda</h2>
              <p>Nenhuma peça nesta categoria por enquanto. Veja o drop completo.</p>
              <Link scroll={false} href={href({ categoria: undefined })} className="btn btn-ghost">
                Ver todas as peças
              </Link>
            </div>
          ) : (
            <div className="grid">
              {catalog.items.map((p, i) => (
                <ViewTransition key={p.slug} enter="card-in" exit="card-out" update="card-move">
                  <ProductCard
                    product={p}
                    priority={i < 4}
                    wide={i === 0 && ordem === 'destaque' && p.featured && p.status === 'ACTIVE'}
                  />
                </ViewTransition>
              ))}
            </div>
          )}
        </section>

        <section className="how section" id="como-comprar" aria-labelledby="titulo-como">
          <div className="wrap">
            <div className="section-head">
              <h2 id="titulo-como">
                Como <em className="chrome-text">comprar</em>
              </h2>
              <p>Sem cadastro e sem senha. Você só precisa de um app de banco com Pix.</p>
            </div>
            <ol className="steps">
              <li>
                <h3>Escolha a peça</h3>
                <p>
                  Coloque no carrinho e finalize com nome, e-mail e WhatsApp. A peça fica reservada
                  para você por 30 minutos.
                </p>
              </li>
              <li>
                <h3>Pague com Pix</h3>
                <p>
                  Leia o QR code ou use o copia e cola no app do seu banco. O valor é calculado pela
                  loja, não pelo navegador.
                </p>
              </li>
              <li>
                <h3>Pronto, é sua</h3>
                <p>
                  A confirmação aparece na tela em segundos, sem precisar mandar comprovante. Na
                  loja, a peça passa a aparecer como vendida.
                </p>
              </li>
            </ol>
          </div>
        </section>
      </div>
    </PageTransition>
  );
}
