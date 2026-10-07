import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="wrap">
      <h1 className="page-title">Não encontrado</h1>
      <p className="muted">Essa página não existe ou a peça saiu do catálogo.</p>
      <p>
        <Link href="/" className="btn btn-ghost">
          Ver o catálogo
        </Link>
      </p>
    </div>
  );
}
