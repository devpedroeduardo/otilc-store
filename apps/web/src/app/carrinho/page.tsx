import type { Metadata } from 'next';
import { Checkout } from '@/components/checkout';

export const metadata: Metadata = { title: 'Carrinho' };

export default function CartPage() {
  return (
    <div className="wrap">
      <h1 className="page-title">Carrinho</h1>
      <Checkout />
    </div>
  );
}
