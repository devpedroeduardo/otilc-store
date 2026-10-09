'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { canTransitionOrder, type AdminOrderDetailDto } from '@otilc/shared';
import { adminApi } from '@/lib/admin-api';
export function OrderActions({ order }: { order: AdminOrderDetailDto }) {
  const [error, setError] = useState('');
  const router = useRouter();
  const choices: AdminOrderDetailDto['status'][] = ['PAID', 'CANCELED', 'SHIPPED'].filter(
    (status) => canTransitionOrder(order.status, status as AdminOrderDetailDto['status']),
  ) as AdminOrderDetailDto['status'][];
  return (
    <div className="admin-actions">
      {choices.map((status) => (
        <button
          className="btn btn-ghost"
          key={status}
          onClick={async () => {
            setError('');
            try {
              await adminApi.updateOrder(order.id, status);
              router.refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Não foi possível atualizar o pedido.');
            }
          }}
        >
          {status === 'PAID' ? 'Marcar pago' : status === 'SHIPPED' ? 'Marcar enviado' : 'Cancelar'}
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
