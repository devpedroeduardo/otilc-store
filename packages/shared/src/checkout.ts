import { z } from 'zod';

/** Item do carrinho enviado pela loja. O preço NUNCA vem do navegador: a API calcula. */
export const cartItemSchema = z.object({
  variantId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(10),
});

export const checkoutSchema = z.object({
  items: z.array(cartItemSchema).min(1, 'O carrinho está vazio.').max(30),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email('E-mail inválido.').max(160),
    phone: z
      .string()
      .trim()
      .regex(/^\+?\d{10,14}$/, 'Telefone inválido.'),
  }),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'CANCELED' | 'EXPIRED' | 'SHIPPED';

export interface OrderItemDto {
  variantId: string;
  productName: string;
  size: string;
  unitPriceCents: number;
  quantity: number;
}

export interface OrderDto {
  id: string;
  number: number;
  status: OrderStatus;
  totalCents: number;
  /** Até quando o estoque fica reservado esperando o pagamento. */
  expiresAt: string;
  items: OrderItemDto[];
}

/** Junta itens repetidos do carrinho (mesma variação) somando as quantidades. */
export function mergeCartItems(items: { variantId: string; quantity: number }[]) {
  const merged = new Map<string, number>();
  for (const item of items)
    merged.set(item.variantId, (merged.get(item.variantId) ?? 0) + item.quantity);
  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity }));
}
