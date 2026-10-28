import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pixChargeSchema } from '@otilc/shared';
import { PedidoPix } from '@/components/pedido-pix';

export const metadata: Metadata = { title: 'Pagamento do pedido' };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Mesmo uuid do contrato: id malformado nem chega à API.
  if (!pixChargeSchema.shape.orderId.safeParse(id).success) notFound();

  return (
    <div className="wrap">
      <h1 className="page-title">Pagamento do pedido</h1>
      <PedidoPix orderId={id} />
    </div>
  );
}
