import type {
  AdminOrderDetailDto,
  AdminOrderListItemDto,
  AdminProductDto,
  AdminUserDto,
  AdminVariantDto,
  Paginated,
} from '@otilc/shared';
import { mockAdminApi, AdminApiError } from './admin-api.mock';

const mock = process.env.NEXT_PUBLIC_ADMIN_MOCK === '1';
export { AdminApiError };

async function request<T>(path: string, init?: RequestInit, cookie?: string): Promise<T> {
  const headers = {
    'content-type': 'application/json',
    ...init?.headers,
    ...(cookie ? { cookie } : {}),
  };
  const url = cookie
    ? `${process.env.API_URL ?? 'http://localhost:3333'}/api/admin${path}`
    : `/api/admin${path}`;
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers,
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = `Não foi possível concluir a solicitação (${response.status}).`;
    try {
      const data = await response.json();
      if (typeof data.message === 'string') message = data.message;
    } catch {
      /* keep generic */
    }
    throw new AdminApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
export const adminApi = {
  login: (input: { email: string; password: string }) =>
    mock
      ? mockAdminApi.login(input.email, input.password)
      : request<AdminUserDto>('/session', json('POST', input)),
  me: () => (mock ? mockAdminApi.me() : request<AdminUserDto>('/me')),
  session: async (cookie: string) => {
    if (mock) return mockAdminApi.me();
    const response = await fetch(`${process.env.API_URL ?? 'http://localhost:3333'}/api/admin/me`, {
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
    if (response.status === 401) return null;
    if (!response.ok)
      throw new AdminApiError(response.status, 'Não foi possível verificar a sessão.');
    return response.json() as Promise<AdminUserDto>;
  },
  logout: () => (mock ? mockAdminApi.logout() : request<void>('/session', { method: 'DELETE' })),
  products: (cookie?: string) =>
    mock ? mockAdminApi.products() : request<AdminProductDto[]>('/products', undefined, cookie),
  product: (id: string, cookie?: string) =>
    mock
      ? mockAdminApi.product(id)
      : request<AdminProductDto>(`/products/${encodeURIComponent(id)}`, undefined, cookie),
  saveProduct: (id: string, input: object) =>
    mock
      ? mockAdminApi.saveProduct(id, input)
      : request<AdminProductDto>(`/products/${encodeURIComponent(id)}`, json('PATCH', input)),
  createProduct: (input: object) =>
    mock
      ? mockAdminApi.createProduct(input)
      : request<AdminProductDto>('/products', json('POST', input)),
  addVariant: (id: string, input: object) =>
    mock
      ? mockAdminApi.addVariant(id, input)
      : request<AdminVariantDto>(
          `/products/${encodeURIComponent(id)}/variants`,
          json('POST', input),
        ),
  updateStock: (id: string, stock: number) =>
    mock
      ? mockAdminApi.updateStock(id, stock)
      : request<AdminVariantDto>(
          `/variants/${encodeURIComponent(id)}/stock`,
          json('PUT', { stock }),
        ),
  orders: (status?: string, cookie?: string) =>
    mock
      ? mockAdminApi.orders(status)
      : request<Paginated<AdminOrderListItemDto>>(
          `/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`,
          undefined,
          cookie,
        ),
  order: (id: string, cookie?: string) =>
    mock
      ? mockAdminApi.order(id)
      : request<AdminOrderDetailDto>(`/orders/${encodeURIComponent(id)}`, undefined, cookie),
  updateOrder: (id: string, status: AdminOrderDetailDto['status']) =>
    mock
      ? mockAdminApi.updateOrder(id, status)
      : request<AdminOrderDetailDto>(
          `/orders/${encodeURIComponent(id)}/status`,
          json('PATCH', { status }),
        ),
};
