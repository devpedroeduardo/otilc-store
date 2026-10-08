import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { formatBRL } from '@otilc/shared';
import { OrderActions } from '@/components/admin/order-actions';
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await adminApi.order(id, (await cookies()).toString()).catch(() => null);
  if (!order) notFound();
  return (
    <>
      <p className="mono muted">PEDIDO · #{order.number}</p>
      <h1 className="page-title">{order.customerName}</h1>
      <div className="panel">
        <p>
          {order.status} · {formatBRL(order.totalCents)}
        </p>
        <p>
          {order.customerEmail} · {order.customerPhone}
        </p>
        {order.items.map((item) => (
          <p key={item.variantId}>
            {item.quantity} × {item.productName} ({item.size}) · {formatBRL(item.unitPriceCents)}
          </p>
        ))}
        <OrderActions order={order} />
      </div>
    </>
  );
}
