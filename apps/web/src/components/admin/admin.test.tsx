import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProductEditor } from './product-editor';
import { OrderActions } from './order-actions';
import { AlertActions } from './alert-actions';
import type { AdminAlertDto, AdminOrderDetailDto, AdminProductDto } from '@otilc/shared';

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
    resolveAlert: vi.fn(),
    resumeReconciliation: vi.fn(),
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
    resolveAlert: mocks.resolveAlert,
    resumeReconciliation: mocks.resumeReconciliation,
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

const alert: AdminAlertDto = {
  id: 'a1',
  type: 'RECONCILIATION_STOPPED',
  createdAt: '2026-10-29T15:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  payment: { id: 'pay1', providerPaymentId: '123', status: 'PENDING', amountCents: 25980 },
  order: { id: 'o1', number: 42, status: 'PENDING_PAYMENT' },
};

describe('AlertActions', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);
  it('resolves an open alert and refreshes', async () => {
    mocks.resolveAlert.mockResolvedValueOnce(alert);
    render(<AlertActions alert={alert} />);
    fireEvent.click(screen.getByRole('button', { name: 'Marcar resolvido' }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.resolveAlert).toHaveBeenCalledWith('a1');
  });
  it('shows the API message on 409', async () => {
    mocks.resolveAlert.mockRejectedValueOnce(
      new mocks.ApiError(409, 'Este alerta já foi marcado como resolvido.'),
    );
    render(<AlertActions alert={alert} />);
    fireEvent.click(screen.getByRole('button', { name: 'Marcar resolvido' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este alerta já foi marcado como resolvido.',
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('redirects to login on 401', async () => {
    mocks.resumeReconciliation.mockRejectedValueOnce(new mocks.ApiError(401, 'Sessão expirada'));
    render(<AlertActions alert={alert} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retomar conciliação' }));
    await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/admin/login'));
  });
  it('offers resume only on stopped reconciliation and resolve only while open', () => {
    const { rerender } = render(<AlertActions alert={{ ...alert, type: 'DUPLICATE_PAYMENT' }} />);
    expect(screen.queryByRole('button', { name: 'Retomar conciliação' })).not.toBeInTheDocument();
    rerender(<AlertActions alert={{ ...alert, resolvedAt: '2026-10-29T16:00:00.000Z' }} />);
    expect(screen.queryByRole('button', { name: 'Marcar resolvido' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retomar conciliação' })).toBeInTheDocument();
  });
});
