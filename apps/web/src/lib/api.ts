import {
  pixChargeSchema,
  pixErrorResponseSchema,
  type CatalogSort,
  type CategoryDto,
  type Paginated,
  type PixChargeDto,
  type PixErrorCode,
  type ProductDetailDto,
  type ProductListItemDto,
} from '@otilc/shared';

const API_URL = process.env.API_URL ?? 'http://localhost:3333';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, { next: { revalidate: 30 } });
  if (!res.ok) throw new ApiError(res.status, `A API respondeu ${res.status} em ${path}`);
  return res.json() as Promise<T>;
}

export function getCategories(): Promise<CategoryDto[]> {
  return get('/categories');
}

export function getProducts(params: {
  categoria?: string;
  ordem?: CatalogSort;
  pagina?: number;
}): Promise<Paginated<ProductListItemDto>> {
  const qs = new URLSearchParams();
  if (params.categoria) qs.set('categoria', params.categoria);
  if (params.ordem) qs.set('ordem', params.ordem);
  if (params.pagina) qs.set('pagina', String(params.pagina));
  const query = qs.toString();
  return get(`/products${query ? `?${query}` : ''}`);
}

export function getProduct(slug: string): Promise<ProductDetailDto> {
  return get(`/products/${encodeURIComponent(slug)}`);
}

// ---------------------------------------------------------------------------
// Pix (spec-014). Chamadas feitas do navegador pela página do pedido.
// ---------------------------------------------------------------------------

const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';

export type PixResult =
  | { kind: 'charge'; charge: PixChargeDto; created: boolean }
  | { kind: 'error'; code: PixErrorCode | 'NOT_FOUND' | 'RATE_LIMITED' | 'FAILED' };

async function pixRequest(orderId: string, method: 'GET' | 'POST'): Promise<PixResult> {
  try {
    const res = await fetch(`${PUBLIC_API_URL}/api/orders/${encodeURIComponent(orderId)}/pix`, {
      method,
      cache: 'no-store',
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 200 || res.status === 201) {
      // Resposta fora do contrato não vira QR code na tela.
      const charge = pixChargeSchema.safeParse(body);
      return charge.success
        ? { kind: 'charge', charge: charge.data, created: res.status === 201 }
        : { kind: 'error', code: 'FAILED' };
    }
    if (res.status === 400 || res.status === 404) return { kind: 'error', code: 'NOT_FOUND' };
    if (res.status === 429) return { kind: 'error', code: 'RATE_LIMITED' };
    const error = pixErrorResponseSchema.safeParse(body);
    if (error.success && (res.status === 409 || res.status === 503)) {
      return { kind: 'error', code: error.data.code };
    }
    return { kind: 'error', code: 'FAILED' };
  } catch {
    return { kind: 'error', code: 'FAILED' };
  }
}

/** Cria a cobrança Pix do pedido ou devolve a que já está pendente. */
export function createPixCharge(orderId: string): Promise<PixResult> {
  return pixRequest(orderId, 'POST');
}

/** Cobrança mais recente do pedido; a API confere o pagamento no provedor quando pendente. */
export function getPixCharge(orderId: string): Promise<PixResult> {
  return pixRequest(orderId, 'GET');
}
