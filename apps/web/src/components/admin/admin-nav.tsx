'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AdminUserDto } from '@otilc/shared';
import { adminApi } from '@/lib/admin-api';
import { BellIcon, BoxIcon, ExternalIcon, LogoutIcon, ReceiptIcon } from '@/components/icons';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Dono', STAFF: 'Equipe' };

export function AdminNav({
  user,
  openAlerts,
  pendingOrders,
}: {
  user: AdminUserDto;
  openAlerts?: number;
  pendingOrders?: number;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
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
  const items = [
    {
      href: '/admin',
      label: 'Produtos',
      icon: <BoxIcon />,
      active: pathname === '/admin' || pathname.startsWith('/admin/products'),
    },
    {
      href: '/admin/orders',
      label: 'Pedidos',
      icon: <ReceiptIcon />,
      active: pathname.startsWith('/admin/orders'),
      tally: pendingOrders,
      tallyTitle: 'aguardando Pix',
    },
    {
      href: '/admin/alerts',
      label: 'Alertas',
      icon: <BellIcon />,
      active: pathname.startsWith('/admin/alerts'),
      tally: openAlerts,
      tallyTitle: 'abertos',
      hot: true,
    },
  ];
  return (
    <aside className="admin-side" style={{ viewTransitionName: 'admin-side' }}>
      <Link href="/admin" className="admin-brand" aria-label="Painel OTILC">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-sm.webp" alt="" width={104} height={24} />
        <span>PAINEL</span>
      </Link>
      <nav aria-label="Administração">
        <p className="admin-menu-label">Gestão</p>
        <div className="admin-menu">
          {items.map((item) => (
            <Link key={item.href} href={item.href} aria-current={item.active ? 'page' : undefined}>
              {item.icon}
              {item.label}
              {item.tally !== undefined && item.tally > 0 && (
                <span
                  className={`tally${item.hot ? ' hot' : ''}`}
                  title={`${item.tally} ${item.tallyTitle}`}
                >
                  {item.tally}
                </span>
              )}
            </Link>
          ))}
          <Link href="/" target="_blank" rel="noopener">
            <ExternalIcon />
            Ver a loja
          </Link>
        </div>
      </nav>
      <div className="admin-user">
        <span className="avatar" aria-hidden="true">
          {user.name.trim().charAt(0).toUpperCase()}
        </span>
        <span className="who">
          <strong>{user.name}</strong>
          <span>{ROLE_LABEL[user.role] ?? user.role}</span>
        </span>
        <button className="icon-btn" onClick={logout} aria-label="Sair" title="Sair">
          <LogoutIcon />
        </button>
      </div>
      {error && (
        <span role="alert" className="alert error">
          {error}
        </span>
      )}
    </aside>
  );
}
