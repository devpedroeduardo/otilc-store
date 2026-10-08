import { sql } from 'drizzle-orm';
import { toCents } from '@otilc/shared';
import { createDatabase, type Database } from './client';
import { categories, productImages, products, variants } from './schema';
import drop from './seed-data/drop-00.json';

interface DropProduct {
  no: string;
  cat: string;
  name: string;
  brand?: string;
  size?: string;
  price: number;
  cond: number | null;
  img: string;
  note?: string;
  feature?: boolean;
}

/** Hosts de banco aceitos pela seed: máquina local, loopback e o serviço `db` do docker compose. */
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', 'db']);

/**
 * Garante que a URL aponta para um banco local. A seed faz TRUNCATE em todas as tabelas, então
 * só pode rodar contra `localhost`, `127.0.0.1` ou o serviço `db` do docker compose.
 * Função pura (só recebe a URL) para poder ser testada sem banco.
 */
export function assertLocalDatabaseUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL inválida: não foi possível identificar o host do banco.');
  }

  if (!LOCAL_DB_HOSTS.has(hostname)) {
    throw new Error(
      `Seed bloqueada: o host "${hostname || '(vazio)'}" do banco não é local. ` +
        `Permitidos: ${[...LOCAL_DB_HOSTS].join(', ')}.`,
    );
  }
}

/** Transforma "Camiseta “dnwr”" em "camiseta-dnwr". */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Popula o banco com o Drop 00 da pré-venda (otilc-landing).
 * Cada peça seminova tem uma unidade só, então vira uma variação com estoque 1.
 */
export async function seed(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`TRUNCATE order_items, orders, product_images, variants, products, categories RESTART IDENTITY CASCADE`,
    );

    const cats = await tx
      .insert(categories)
      .values(drop.categories.map((c, i) => ({ slug: c.id, name: c.name, position: i })))
      .returning();
    const catId = new Map(cats.map((c) => [c.slug, c.id]));

    const base = Date.now();
    for (const [i, p] of (drop.products as DropProduct[]).entries()) {
      const categoryId = catId.get(p.cat);
      if (!categoryId) throw new Error(`Categoria desconhecida: ${p.cat}`);

      const [product] = await tx
        .insert(products)
        .values({
          slug: `${p.no}-${slugify(p.name)}`,
          name: p.name,
          brand: p.brand ?? null,
          note: p.note ?? null,
          priceCents: toCents(p.price),
          condition: p.cond === null ? null : p.cond.toFixed(1),
          featured: Boolean(p.feature),
          categoryId,
          // Mantém a ordem do drop na ordenação por novidade.
          createdAt: new Date(base - i * 1000),
        })
        .returning({ id: products.id });

      await tx.insert(variants).values({
        productId: product.id,
        sku: `OTILC-D00-${p.no}`,
        size: p.size ?? 'Único',
        stock: 1,
      });

      await tx.insert(productImages).values({
        productId: product.id,
        url: `/products/${p.img}-800.webp`,
        alt: `${p.name}${p.brand ? ` · ${p.brand}` : ''}`,
        position: 0,
      });
    }
  });
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Defina DATABASE_URL.');
  assertLocalDatabaseUrl(url);
  const { db, pool } = createDatabase(url);
  seed(db)
    .then(() =>
      console.log(`Seed concluído: ${drop.products.length} produtos do Drop ${drop.drop}.`),
    )
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
