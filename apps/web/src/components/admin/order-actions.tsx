'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { canTransitionOrder, type AdminOrderDetailDto } from '@otilc/shared';
import { adminApi } from '@/lib/admin-api';
const LABEL: Partial<Record<AdminOrderDetailDto['status'], string>> = {
  PAID: 'Marcar pago',
  SHIPPED: 'Marcar enviado',
  CANCELED: 'Cancelar',
};
export function OrderActions({ order }: { order: AdminOrderDetailDto }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const choices: AdminOrderDetailDto['status'][] = ['PAID', 'CANCELED', 'SHIPPED'].filter(
    (status) => canTransitionOrder(order.status, status as AdminOrderDetailDto['status']),
  ) as AdminOrderDetailDto['status'][];
  if (choices.length === 0) {
    return <p className="hint">Este pedido está encerrado. Não há mais ações.</p>;
  }
  return (
    <div className="admin-actions">
      {choices.map((status) => (
        <button
          className={`btn btn-sm ${status === 'CANCELED' ? 'btn-danger' : 'btn-solid'}`}
          key={status}
          disabled={busy}
          onClick={async () => {
            setError('');
            setBusy(true);
            try {
              await adminApi.updateOrder(order.id, status);
              router.refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Não foi possível atualizar o pedido.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {LABEL[status]}
        </button>
      ))}
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
    </div>
  );
}
