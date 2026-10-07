import type {
  CatalogSort,
  CategoryDto,
  Paginated,
  ProductDetailDto,
  ProductListItemDto,
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
