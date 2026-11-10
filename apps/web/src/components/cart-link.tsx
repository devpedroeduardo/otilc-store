'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useCart } from './cart-context';
import { BagIcon } from './icons';

export function CartLink() {
  const { count, ready } = useCart();
  const shown = ready ? count : 0;
  // O contador pula quando uma peça entra no carrinho (não na primeira leitura).
  const previous = useRef<number | null>(null);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (!ready) return;
    if (previous.current !== null && count > previous.current) setBump(true);
    previous.current = count;
  }, [count, ready]);

  return (
    <Link href="/carrinho" className="cart-link" aria-label={`Carrinho, ${shown} item(ns)`}>
      <BagIcon />
      <span className="label mono">Carrinho</span>
      <span
        className={`cart-count mono${bump ? ' bump' : ''}`}
        onAnimationEnd={() => setBump(false)}
      >
        {shown}
      </span>
    </Link>
  );
}
