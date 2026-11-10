import { ViewTransition } from '@/components/view-transition';

export default function AdminLoading() {
  return (
    <ViewTransition exit="skeleton-out" default="none">
      <div className="admin-loading" aria-live="polite" aria-busy="true">
        <span className="sr-only">Carregando o painel…</span>
        <div className="skeleton" style={{ height: 72, maxWidth: 360 }} />
        <div className="stats">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 92 }} />
          ))}
        </div>
        <div className="skeleton" style={{ height: 360 }} />
      </div>
    </ViewTransition>
  );
}
