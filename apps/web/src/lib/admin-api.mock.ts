import type {
  AdminAlertDto,
  AdminAlertQuery,
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
    images: [{ url: '/products/zara-branca-800.webp', alt: 'Camiseta Veja Além' }],
    variants: [
      { id: 'variant-demo', sku: 'CAM-VA-P', size: 'P', color: 'Preto', stock: 5, reserved: 1 },
    ],
    createdAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:00.000Z',
  },
];

// Mais peças de exemplo, com fotos do catálogo, para o painel não parecer vazio no modo mock.
products.push(
  {
    ...products[0]!,
    id: 'product-demo-2',
    slug: '01-air-jordan-3-retro',
    name: 'Air Jordan 3 Retro',
    brand: 'Nike',
    priceCents: 70000,
    condition: 6,
    featured: false,
    category: { slug: 'tenis', name: 'Tênis' },
    images: [{ url: '/products/jordan-800.webp', alt: 'Air Jordan 3 Retro' }],
    variants: [
      { id: 'variant-demo-2', sku: 'AJ3-42', size: '42', color: null, stock: 1, reserved: 0 },
    ],
  },
  {
    ...products[0]!,
    id: 'product-demo-3',
    slug: '07-casaco',
    name: 'Casaco Puffer',
    brand: null,
    priceCents: 18000,
    condition: 8.5,
    status: 'SOLD_OUT',
    featured: false,
    category: { slug: 'casacos', name: 'Casacos' },
    images: [{ url: '/products/casaco-800.webp', alt: 'Casaco Puffer' }],
    variants: [
      { id: 'variant-demo-3', sku: 'CAS-M', size: 'M', color: null, stock: 0, reserved: 0 },
    ],
  },
);
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

orders.push(
  {
    ...orders[0]!,
    id: 'order-demo-2',
    number: 41,
    status: 'PAID',
    customerName: 'Bruno Lima',
    customerEmail: 'bruno@example.com',
    totalCents: 70000,
    createdAt: '2026-10-07T18:20:00.000Z',
    items: [
      {
        ...orders[0]!.items[0]!,
        productName: 'Air Jordan 3 Retro',
        sku: 'AJ3-42',
        size: '42',
        unitPriceCents: 70000,
        quantity: 1,
      },
    ],
  },
  {
    ...orders[0]!,
    id: 'order-demo-3',
    number: 40,
    status: 'SHIPPED',
    customerName: 'Carla Mendes',
    customerEmail: 'carla@example.com',
    totalCents: 18000,
    createdAt: '2026-10-06T10:05:00.000Z',
    items: [
      {
        ...orders[0]!.items[0]!,
        productName: 'Casaco Puffer',
        sku: 'CAS-M',
        size: 'M',
        unitPriceCents: 18000,
        quantity: 1,
      },
    ],
  },
);

const alerts: AdminAlertDto[] = [
  {
    id: 'alert-demo',
    type: 'RECONCILIATION_STOPPED',
    createdAt: '2026-10-29T15:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    payment: {
      id: 'payment-demo',
      providerPaymentId: '1234567890',
      status: 'PENDING',
      amountCents: 25980,
    },
    order: { id: 'order-demo', number: 1, status: 'PENDING_PAYMENT' },
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
  async alerts(query: Partial<AdminAlertQuery>): Promise<Paginated<AdminAlertDto>> {
    const situation = query.situacao ?? 'abertos';
    const filtered = alerts.filter(
      (item) =>
        (situation === 'todos' || (situation === 'abertos') === (item.resolvedAt === null)) &&
        (!query.tipo || item.type === query.tipo),
    );
    return { items: filtered, page: 1, perPage: 20, total: filtered.length, totalPages: 1 };
  },
  async resolveAlert(id: string) {
    const alert = alerts.find((item) => item.id === id) ?? alerts[0]!;
    if (alert.resolvedAt)
      throw new AdminApiError(409, 'Este alerta já foi marcado como resolvido.');
    alert.resolvedAt = new Date().toISOString();
    alert.resolvedBy = owner.name;
    return alert;
  },
  async resumeReconciliation(id: string) {
    return alerts.find((item) => item.id === id) ?? alerts[0]!;
  },
};
