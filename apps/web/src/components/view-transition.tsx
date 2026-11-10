import * as React from 'react';

/**
 * `<ViewTransition>` do React. No Next 15.5 ele existe como `unstable_ViewTransition`, só com
 * `experimental.viewTransition` ligado; os tipos (@types/react 19.3) já usam o nome estável.
 * Sem a API (flag desligada, testes com React estável), vira um repasse: a página funciona igual,
 * só não anima.
 */
type ViewTransitionComponent = typeof React.ViewTransition;

function Passthrough({ children }: React.ViewTransitionProps) {
  return <>{children}</>;
}

const api = React as unknown as Record<string, unknown>;

export const ViewTransition = (api.ViewTransition ??
  api.unstable_ViewTransition ??
  Passthrough) as ViewTransitionComponent;

const addType = (api.addTransitionType ?? api.unstable_addTransitionType) as
  ((type: string) => void) | undefined;

/** Marca o tipo da transição em andamento, quando a API existe. */
export function addTransitionType(type: string): void {
  addType?.(type);
}

/** Entrada e saída de cada página da loja. Fica na página, nunca no layout. */
export function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="page-in" exit="page-out" default="none">
      {children}
    </ViewTransition>
  );
}

/** Conteúdo do painel subindo ao chegar (troca de aba e fim do carregamento). */
export function AdminReveal({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="reveal-up" default="none">
      {children}
    </ViewTransition>
  );
}
