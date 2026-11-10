import type { Metadata } from 'next';
import { Checkout } from '@/components/checkout';
import { Flow } from '@/components/flow';
import { PageTransition } from '@/components/view-transition';

export const metadata: Metadata = { title: 'Carrinho' };

export default function CartPage() {
  return (
    <PageTransition>
      <div className="wrap">
        <Flow current={0} />
        <h1 className="page-title">Carrinho</h1>
        <Checkout />
      </div>
    </PageTransition>
  );
}
