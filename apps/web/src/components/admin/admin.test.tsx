import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProductEditor } from './product-editor';
import { OrderActions } from './order-actions';
import type { AdminOrderDetailDto, AdminProductDto } from '@otilc/shared';

const mocks = vi.hoisted(() => {
  class TestAdminApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    updateStock: vi.fn(),
    updateOrder: vi.fn(),
    saveProduct: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    session: vi.fn(),
    ApiError: TestAdminApiError,
  };
});
vi.mock('@/lib/admin-api', () => ({
  adminApi: {
    updateStock: mocks.updateStock,
    updateOrder: mocks.updateOrder,
    saveProduct: mocks.saveProduct,
    session: mocks.session,
  },
  AdminApiError: mocks.ApiError,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
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
const conditionedProduct: AdminProductDto = {
  ...product,
  condition: 8.5,
  note: 'Pequena marca na manga',
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
  afterEach(() => cleanup());
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
    mocks.updateStock.mockRejectedValueOnce(
      new mocks.ApiError(409, 'Reservas atuais impedem reduzir o estoque para 2.'),
    );
    render(<ProductEditor product={product} role="OWNER" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Atualizar' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Reservas atuais impedem reduzir o estoque para 2.',
    );
  });
  it('retains condition and note when saving only a product name change', async () => {
    mocks.saveProduct.mockImplementation(async (_id: string, patch: Partial<AdminProductDto>) => {
      Object.assign(conditionedProduct, patch);
      return conditionedProduct;
    });
    render(<ProductEditor product={conditionedProduct} role="OWNER" />);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Camiseta nova' } });
    fireEvent.submit(screen.getByLabelText('Nome').closest('form')!);
    await screen.findByRole('status');
    expect(conditionedProduct.condition).toBe(8.5);
    expect(conditionedProduct.note).toBe('Pequena marca na manga');
  });
  it('redirects to login when stock update receives 401', async () => {
    mocks.updateStock.mockRejectedValueOnce(new mocks.ApiError(401, 'Sessão expirada'));
    render(<ProductEditor product={product} role="OWNER" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Atualizar' })[0]!);
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/admin/login'));
  });
  it('shows a generic message for non-409 stock errors', async () => {
    mocks.updateStock.mockRejectedValueOnce(new mocks.ApiError(500, 'Internal Server Error'));
    render(<ProductEditor product={product} role="OWNER" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Atualizar' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível atualizar o estoque. Tente novamente.',
    );
  });
  it('redirects protected admin pages when there is no session', async () => {
    mocks.session.mockResolvedValueOnce(null);
    const { default: ProtectedLayout } = await import('../../app/admin/(protected)/layout');
    await expect(ProtectedLayout({ children: <p>private</p> })).rejects.toThrow(
      'REDIRECT:/admin/login',
    );
  });
});
