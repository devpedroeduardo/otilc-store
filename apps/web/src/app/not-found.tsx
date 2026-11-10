import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="conteudo" className="wrap lost">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-eye-static" src="/brand/eye.webp" alt="" width={900} height={712} />
        <span className="code chrome-text" aria-hidden="true">
          404
        </span>
        <h1 className="page-title">Não encontrado</h1>
        <p className="muted">Essa página não existe ou a peça saiu do catálogo.</p>
        <Link href="/" className="btn btn-solid">
          Ver o catálogo
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
