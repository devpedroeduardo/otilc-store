'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface CartLine {
  variantId: string;
  slug: string;
  name: string;
  size: string;
  priceCents: number;
  image: string | null;
  quantity: number;
}

interface CartState {
  lines: CartLine[];
  count: number;
  /** Total mostrado na tela. O valor cobrado é sempre recalculado pela API. */
  subtotalCents: number;
  ready: boolean;
  add: (line: Omit<CartLine, 'quantity'>) => void;
  remove: (variantId: string) => void;
  clear: () => void;
}

const STORAGE_KEY = 'otilc:cart:v1';
const CartContext = createContext<CartState | null>(null);

function readStorage(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLines(readStorage());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // Armazenamento indisponível (modo privado): o carrinho funciona só nesta aba.
    }
  }, [lines, ready]);

  // Peças seminovas têm uma unidade cada: adicionar de novo não aumenta a quantidade.
  const add = useCallback((line: Omit<CartLine, 'quantity'>) => {
    setLines((prev) =>
      prev.some((l) => l.variantId === line.variantId) ? prev : [...prev, { ...line, quantity: 1 }],
    );
  }, []);
  const remove = useCallback(
    (variantId: string) => setLines((prev) => prev.filter((l) => l.variantId !== variantId)),
    [],
  );
  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartState>(
    () => ({
      lines,
      ready,
      count: lines.reduce((n, l) => n + l.quantity, 0),
      subtotalCents: lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0),
      add,
      remove,
      clear,
    }),
    [lines, ready, add, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart precisa estar dentro de <CartProvider>.');
  return ctx;
}
