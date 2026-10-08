import { z } from 'zod';
import {
  conditionSchema,
  productStatusSchema,
  type CategoryDto,
  type ProductImageDto,
} from './catalog';
import type { OrderStatus } from './checkout';

// ---------------------------------------------------------------------------
// Autenticação e papéis (ADR 0002)
// ---------------------------------------------------------------------------

export const adminRoleSchema = z.enum(['OWNER', 'STAFF']);
export type AdminRole = z.infer<typeof adminRoleSchema>;

/** Corpo do login. O e-mail é normalizado (trim + minúsculas), como é gravado no banco. */
export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido.').max(160),
  password: z.string().min(12, 'A senha precisa ter ao menos 12 caracteres.').max(200),
});
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

/** Usuário do painel como a API devolve. Nunca inclui hash de senha nem de sessão. */
export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

/** Tudo que um usuário do painel pode fazer. Cada endpoint de `docs/api/admin.md` exige uma ação. */
export const adminActions = [
  'product:read',
  'product:create',
  'product:update',
  'variant:create',
  'stock:update',
  'order:read',
  'order:updateStatus',
] as const;
export type AdminAction = (typeof adminActions)[number];

const roleActions: Record<AdminRole, ReadonlySet<AdminAction>> = {
  OWNER: new Set(adminActions),
  // STAFF consulta, ajusta estoque e anda com pedidos. Não cria nem edita produto (inclusive preço).
  STAFF: new Set<AdminAction>(['product:read', 'stock:update', 'order:read', 'order:updateStatus']),
};

/** Diz se o papel pode executar a ação. Papel ou ação desconhecidos: não pode. */
export function canRole(role: AdminRole, action: AdminAction): boolean {
  return roleActions[role]?.has(action) ?? false;
}

// ---------------------------------------------------------------------------
// Produtos, variações e estoque
// ---------------------------------------------------------------------------

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use letras minúsculas, números e hífens.');

/** Cadastro de produto. O preço vem do painel do dono, em centavos inteiros. */
export const adminProductInputSchema = z.object({
  slug: slugSchema.max(120),
  name: z.string().trim().min(2).max(160),
  brand: z.string().trim().min(1).max(120).nullable().optional(),
  description: z.string().trim().min(1).max(5000).nullable().optional(),
  note: z.string().trim().min(1).max(240).nullable().optional(),
  priceCents: z.number().int().positive().max(100_000_000),
  condition: conditionSchema,
  status: productStatusSchema,
  featured: z.boolean(),
  categorySlug: slugSchema.max(40),
});
export type AdminProductInput = z.infer<typeof adminProductInputSchema>;

/** Edição parcial de produto: qualquer subconjunto dos campos do cadastro. */
export const adminProductPatchSchema = adminProductInputSchema.partial();
export type AdminProductPatch = z.infer<typeof adminProductPatchSchema>;

export const adminVariantInputSchema = z.object({
  sku: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]+$/, 'SKU inválido.')
    .min(1)
    .max(64),
  size: z.string().trim().min(1).max(20),
  color: z.string().trim().min(1).max(40).nullable().optional(),
  stock: z.number().int().min(0).max(100_000),
});
export type AdminVariantInput = z.infer<typeof adminVariantInputSchema>;

/** Novo estoque total da variação. A API recusa (409) se ficar abaixo do reservado. */
export const adminStockUpdateSchema = z.object({
  stock: z.number().int().min(0).max(100_000),
});
export type AdminStockUpdate = z.infer<typeof adminStockUpdateSchema>;

export interface AdminVariantDto {
  id: string;
  sku: string;
  size: string;
  color: string | null;
  stock: number;
  /** Unidades presas em pedidos aguardando pagamento. */
  reserved: number;
}

export interface AdminProductDto {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  description: string | null;
  note: string | null;
  priceCents: number;
  condition: number | null;
  status: z.infer<typeof productStatusSchema>;
  featured: boolean;
  category: CategoryDto;
  images: ProductImageDto[];
  variants: AdminVariantDto[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

export const orderStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'PAID',
  'CANCELED',
  'EXPIRED',
  'SHIPPED',
]) satisfies z.ZodType<OrderStatus>;

/** Filtros da listagem de pedidos do painel (query string). */
export const adminOrderQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  pagina: z.coerce.number().int().min(1).max(500).default(1),
  porPagina: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminOrderQuery = z.infer<typeof adminOrderQuerySchema>;

/** Novo status do pedido. Transição inválida (ver `canTransitionOrder`) é recusada com 409. */
export const adminOrderStatusUpdateSchema = z.object({
  status: orderStatusSchema,
});
export type AdminOrderStatusUpdate = z.infer<typeof adminOrderStatusUpdateSchema>;

const orderTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELED'],
  PAID: ['SHIPPED', 'CANCELED'],
  CANCELED: [],
  EXPIRED: [],
  SHIPPED: [],
};

/** Transições de status que o painel pode fazer. `EXPIRED` só é aplicado pelo job de expiração. */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return orderTransitions[from]?.includes(to) ?? false;
}

export interface AdminOrderListItemDto {
  id: string;
  number: number;
  status: OrderStatus;
  customerName: string;
  totalCents: number;
  itemCount: number;
  expiresAt: string;
  createdAt: string;
}

export interface AdminOrderItemDto {
  variantId: string;
  sku: string;
  productName: string;
  size: string;
  unitPriceCents: number;
  quantity: number;
}

export interface AdminOrderDetailDto extends Omit<AdminOrderListItemDto, 'itemCount'> {
  customerEmail: string;
  customerPhone: string;
  items: AdminOrderItemDto[];
}
