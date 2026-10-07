import Link from 'next/link';
import { catalogSortSchema, type CatalogSort } from '@otilc/shared';
import { ProductCard } from '@/components/product-card';
import { getCategories, getProducts } from '@/lib/api';

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

  const [categories, catalog] = await Promise.all([
    getCategories(),
    getProducts({ categoria, ordem, pagina: 1 }),
  ]);

  const href = (next: { categoria?: string; ordem?: CatalogSort }) => {
    const qs = new URLSearchParams();
    const c = 'categoria' in next ? next.categoria : categoria;
    const o = next.ordem ?? ordem;
    if (c) qs.set('categoria', c);
    if (o !== 'destaque') qs.set('ordem', o);
    const s = qs.toString();
    return s ? `/?${s}` : '/';
  };

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <span className="mono muted">Drop 00 · peças únicas</span>
          <h1>
            Veja <em className="chrome-text">além.</em>
          </h1>
          <p className="lede">
            Peças selecionadas, uma unidade de cada. O estoque é atualizado em tempo real e o
            pagamento é por Pix.
          </p>
        </div>
      </section>

      <section className="wrap" aria-labelledby="titulo-catalogo">
        <h2 id="titulo-catalogo" className="sr-only">
          Catálogo
        </h2>
        <div className="toolbar">
          <nav className="chips" aria-label="Categorias">
            <Link
              href={href({ categoria: undefined })}
              className="chip"
              aria-current={!categoria ? 'page' : undefined}
            >
              Tudo
            </Link>
            {categories.map((c) => (
              <Link
                key={c.slug}
                href={href({ categoria: c.slug })}
                className="chip"
                aria-current={categoria === c.slug ? 'page' : undefined}
              >
                {c.name}
              </Link>
            ))}
          </nav>
          <nav className="sort mono" aria-label="Ordenar">
            {SORTS.map((s) => (
              <Link
                key={s.value}
                href={href({ ordem: s.value })}
                aria-current={ordem === s.value ? 'true' : undefined}
              >
                {s.label}
              </Link>
            ))}
          </nav>
        </div>

        {catalog.items.length === 0 ? (
          <p className="empty">Nenhuma peça nesta categoria por enquanto.</p>
        ) : (
          <div className="grid">
            {catalog.items.map((p, i) => (
              <ProductCard key={p.slug} product={p} priority={i < 4} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
