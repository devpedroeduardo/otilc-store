import Link from 'next/link';
import { CartLink } from './cart-link';

/** Cabeçalho da loja. Também usado pela página 404, que fica fora do grupo `(loja)`. */
export function SiteHeader() {
  return (
    <>
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>
      <header className="site-header" style={{ viewTransitionName: 'site-header' }}>
        <div className="wrap">
          <Link href="/" className="brand" aria-label="OTILC, página inicial">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-sm.webp" alt="OTILC" width={120} height={28} />
          </Link>
          <nav className="site-nav" aria-label="Principal">
            <Link href="/#pecas">Peças</Link>
            <Link href="/?ordem=novidades#pecas">Novidades</Link>
            <Link href="/#como-comprar">Como comprar</Link>
          </nav>
          <CartLink />
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo-sm.webp"
            alt="OTILC"
            width={120}
            height={28}
            style={{ height: 28, width: 'auto', marginBottom: 16 }}
          />
          <p>
            Streetwear seminovo, garimpado peça por peça. Cada item tem uma unidade só: quando
            vende, não volta.
          </p>
        </div>
        <nav aria-label="Loja">
          <h2>Loja</h2>
          <ul>
            <li>
              <Link href="/#pecas">Todas as peças</Link>
            </li>
            <li>
              <Link href="/?ordem=novidades#pecas">Novidades</Link>
            </li>
            <li>
              <Link href="/?ordem=menor-preco#pecas">Menor preço</Link>
            </li>
            <li>
              <Link href="/carrinho">Carrinho</Link>
            </li>
          </ul>
        </nav>
        <div>
          <h2>Compra</h2>
          <ul>
            <li>Pagamento por Pix</li>
            <li>Peça reservada por 30 min</li>
            <li>Confirmação automática</li>
            <li>
              <Link href="/#como-comprar">Como funciona</Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="wrap" aria-hidden="true">
        <span className="footer-mark">Veja além</span>
      </div>
      <div className="wrap footer-bottom">
        <span>© {year} OTILC</span>
        <span>Pagamentos processados pelo Mercado Pago</span>
      </div>
    </footer>
  );
}
