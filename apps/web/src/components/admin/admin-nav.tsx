'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AdminUserDto } from '@otilc/shared';
import { adminApi } from '@/lib/admin-api';
export function AdminNav({ user }: { user: AdminUserDto }) {
  const router = useRouter();
  const [error, setError] = useState('');
  async function logout() {
    try {
      await adminApi.logout();
      router.push('/admin/login');
      router.refresh();
    } catch {
      setError('Não foi possível sair. Tente novamente.');
    }
  }
  return (
    <header className="site-header">
      <nav className="wrap admin-nav" aria-label="Administração">
        <Link href="/admin" className="brand">
          OTILC <span className="mono">ADMIN</span>
        </Link>
        <div className="admin-links">
          <Link href="/admin">Produtos</Link>
          <Link href="/admin/orders">Pedidos</Link>
          <span className="muted">
            {user.name} · {user.role}
          </span>
          <button className="link-btn" onClick={logout}>
            Sair
          </button>
        </div>
        {error && <span role="alert">{error}</span>}
      </nav>
    </header>
  );
}
