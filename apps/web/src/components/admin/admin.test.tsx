import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProductEditor } from './product-editor';
import { OrderActions } from './order-actions';
import type { AdminOrderDetailDto, AdminProductDto } from '@otilc/shared';

const mocks = vi.hoisted(() => ({
  updateStock: vi.fn(),
  updateOrder: vi.fn(),
  refresh: vi.fn(),
  session: vi.fn(),
}));
vi.mock('@/lib/admin-api', () => ({
  adminApi: {
    updateStock: mocks.updateStock,
    updateOrder: mocks.updateOrder,
    session: mocks.session,
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ toString: () => '' }) }));

const product: AdminProductDto = {
  id: 'p1',
  slug: 'tee',
  name: 'Camiseta',
  brand: 'OTILC',
  description: null,
  note: null,
  priceCents: 12000,
  condition: null,
  status: 'ACTIVE',
  featured: false,
  category: { slug: 'camisetas', name: 'Camisetas' },
  images: [],
  variants: [{ id: 'v1', sku: 'TEE-P', size: 'P', color: 'Preto', stock: 4, reserved: 3 }],
  createdAt: '',
  updatedAt: '',
};
const order: AdminOrderDetailDto = {
  id: 'o1',
  number: 1,
  status: 'PENDING_PAYMENT',
  customerName: 'Ana',
  customerEmail: 'ana@example.com',
  customerPhone: '000',
  totalCents: 12000,
  expiresAt: '',
  createdAt: '',
  items: [],
};

describe('admin panels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('does not expose product editing or price controls to STAFF', () => {
    render(<ProductEditor product={product} role="STAFF" />);
    expect(screen.getByLabelText('Preço em centavos')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Salvar produto' })).not.toBeInTheDocument();
    expect(screen.queryByText('Nova variação')).not.toBeInTheDocument();
  });
  it('only shows allowed order status transitions', () => {
    render(<OrderActions order={order} />);
    expect(screen.getByRole('button', { name: 'Marcar pago' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar enviado' })).not.toBeInTheDocument();
  });
  it('shows the reserved stock conflict message', async () => {
    mocks.updateStock.mockRejectedValueOnce(new Error('409 conflict'));
    render(<ProductEditor product={product} role="OWNER" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Atualizar' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('abaixo das 3 unidades reservadas');
  });
  it('redirects protected admin pages when there is no session', async () => {
    mocks.session.mockResolvedValueOnce(null);
    const { default: ProtectedLayout } = await import('../../app/admin/(protected)/layout');
    await expect(ProtectedLayout({ children: <p>private</p> })).rejects.toThrow(
      'REDIRECT:/admin/login',
    );
  });
});
