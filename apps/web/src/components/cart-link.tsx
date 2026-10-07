'use client';

import Link from 'next/link';
import { useCart } from './cart-context';

export function CartLink() {
  const { count, ready } = useCart();
  return (
    <Link href="/carrinho" className="cart-link mono" aria-label={`Carrinho, ${count} item(ns)`}>
      Carrinho <span className="cart-count">{ready ? count : 0}</span>
    </Link>
  );
}
