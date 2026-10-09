import type {
  AdminOrderDetailDto,
  AdminOrderListItemDto,
  AdminProductDto,
  AdminUserDto,
  AdminVariantDto,
  Paginated,
} from '@otilc/shared';

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const owner: AdminUserDto = {
  id: 'admin-demo',
  email: 'dono@example.com',
  name: 'Dono OTILC',
  role: 'OWNER',
};
const staff: AdminUserDto = { ...owner, id: 'staff-demo', name: 'Equipe OTILC', role: 'STAFF' };
const products: AdminProductDto[] = [
  {
    id: 'product-demo',
    slug: 'camiseta-veja-alem',
    name: 'Camiseta Veja Além',
    brand: 'OTILC',
    description: 'Algodão 100%.',
    note: null,
    priceCents: 12990,
    condition: null,
    status: 'ACTIVE',
    featured: true,
    category: { slug: 'camisetas', name: 'Camisetas' },
    images: [],
    variants: [
      { id: 'variant-demo', sku: 'CAM-VA-P', size: 'P', color: 'Preto', stock: 5, reserved: 1 },
    ],
    createdAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:00.000Z',
  },
];
const orders: AdminOrderDetailDto[] = [
  {
    id: 'order-demo',
    number: 42,
    status: 'PENDING_PAYMENT',
    customerName: 'Ana Souza',
    customerEmail: 'ana@example.com',
    customerPhone: '+5585999990000',
    totalCents: 25980,
    expiresAt: '2026-10-08T12:30:00.000Z',
    createdAt: '2026-10-08T12:00:00.000Z',
    items: [
      {
        variantId: 'variant-demo',
        sku: 'CAM-VA-P',
        productName: 'Camiseta Veja Além',
        size: 'P',
        unitPriceCents: 12990,
        quantity: 2,
      },
    ],
  },
];

export const mockAdminApi = {
  async login(email: string, _password: string) {
    return email.includes('staff') ? staff : owner;
  },
  async me() {
    return owner;
  },
  async logout() {},
  async products() {
    return products;
  },
  async product(id: string) {
    return products.find((item) => item.id === id) ?? products[0]!;
  },
  async saveProduct(id: string, input: Partial<AdminProductDto>) {
    const current = products.find((item) => item.id === id) ?? products[0]!;
    Object.assign(current, input);
    return current;
  },
  async createProduct(input: Partial<AdminProductDto>) {
    const item = { ...products[0]!, ...input, id: `product-${Date.now()}` };
    products.push(item);
    return item;
  },
  async addVariant(_id: string, input: Partial<AdminVariantDto>) {
    const item = {
      id: `variant-${Date.now()}`,
      sku: input.sku ?? '',
      size: input.size ?? '',
      color: input.color ?? null,
      stock: input.stock ?? 0,
      reserved: 0,
    };
    products[0]!.variants.push(item);
    return item;
  },
  async updateStock(id: string, stock: number) {
    const variant =
      products.flatMap((item) => item.variants).find((item) => item.id === id) ??
      products[0]!.variants[0]!;
    if (stock < variant.reserved)
      throw new AdminApiError(
        409,
        `O estoque não pode ficar abaixo das ${variant.reserved} unidades reservadas.`,
      );
    variant.stock = stock;
    return variant;
  },
  async orders(status?: string): Promise<Paginated<AdminOrderListItemDto>> {
    const filtered = orders
      .filter((item) => !status || item.status === status)
      .map(({ customerEmail, customerPhone, items, ...item }) => ({
        ...item,
        itemCount: items.reduce((count, line) => count + line.quantity, 0),
      }));
    return { items: filtered, page: 1, perPage: 20, total: filtered.length, totalPages: 1 };
  },
  async order(id: string) {
    return orders.find((item) => item.id === id) ?? orders[0]!;
  },
  async updateOrder(id: string, status: AdminOrderDetailDto['status']) {
    const order = orders.find((item) => item.id === id) ?? orders[0]!;
    order.status = status;
    return order;
  },
};
