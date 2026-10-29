'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminAlertDto } from '@otilc/shared';
import { adminApi, AdminApiError } from '@/lib/admin-api';
export function AlertActions({ alert }: { alert: AdminAlertDto }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function run(action: (id: string) => Promise<unknown>, fallback: string) {
    setError('');
    setBusy(true);
    try {
      await action(alert.id);
      router.refresh();
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 401) {
        router.replace('/admin/login');
        return;
      }
      // O 409 traz a mensagem em português da API (inclusive códigos novos).
      setError(e instanceof AdminApiError && e.status === 409 ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  const open = alert.resolvedAt === null;
  return (
    <div className="admin-actions">
      {open && (
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() =>
            run(adminApi.resolveAlert, 'Não foi possível marcar o alerta como resolvido.')
          }
        >
          Marcar resolvido
        </button>
      )}
      {alert.type === 'RECONCILIATION_STOPPED' && (
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() =>
            run(adminApi.resumeReconciliation, 'Não foi possível retomar a conciliação.')
          }
        >
          Retomar conciliação
        </button>
      )}
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
    </div>
  );
}
