'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  adminProductInputSchema,
  adminProductPatchSchema,
  adminVariantInputSchema,
  adminStockUpdateSchema,
  canRole,
  type AdminProductDto,
  type AdminRole,
} from '@otilc/shared';
import { adminApi } from '@/lib/admin-api';
export function ProductEditor({
  product,
  role,
  create = false,
}: {
  product?: AdminProductDto;
  role: AdminRole;
  create?: boolean;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = canRole(role, 'product:update');
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const raw = {
      slug: data.get('slug'),
      name: data.get('name'),
      brand: data.get('brand') || null,
      description: data.get('description') || null,
      note: data.get('note') || null,
      priceCents: Number(data.get('priceCents')),
      condition: null,
      status: data.get('status'),
      featured: data.get('featured') === 'on',
      categorySlug: data.get('categorySlug'),
    };
    const schema = create ? adminProductInputSchema : adminProductPatchSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    setBusy(true);
    try {
      if (create) await adminApi.createProduct(parsed.data);
      else await adminApi.saveProduct(product!.id, parsed.data);
      setNotice('Produto salvo.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }
  async function addVariant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const parsed = adminVariantInputSchema.safeParse({
      sku: data.get('sku'),
      size: data.get('size'),
      color: data.get('color') || null,
      stock: Number(data.get('stock')),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    try {
      await adminApi.addVariant(product!.id, parsed.data);
      setNotice('Variação criada.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível criar variação.');
    }
  }
  async function stock(event: React.FormEvent<HTMLFormElement>, id: string, reserved: number) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const parsed = adminStockUpdateSchema.safeParse({ stock: Number(data.get('stock')) });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Estoque inválido.');
      return;
    }
    try {
      await adminApi.updateStock(id, parsed.data.stock);
      setNotice('Estoque atualizado.');
      router.refresh();
    } catch {
      setError(`O estoque não pode ficar abaixo das ${reserved} unidades reservadas.`);
    }
  }
  return (
    <>
      <form className="panel admin-form" onSubmit={save}>
        <label className="field">
          Nome
          <input name="name" defaultValue={product?.name} required disabled={!owner} />
        </label>
        <label className="field">
          Slug
          <input name="slug" defaultValue={product?.slug} required disabled={!owner} />
        </label>
        <label className="field">
          Marca
          <input name="brand" defaultValue={product?.brand ?? ''} disabled={!owner} />
        </label>
        <label className="field">
          Categoria (slug)
          <input
            name="categorySlug"
            defaultValue={product?.category.slug}
            required
            disabled={!owner}
          />
        </label>
        <label className="field">
          Descrição
          <textarea
            name="description"
            defaultValue={product?.description ?? ''}
            disabled={!owner}
          />
        </label>
        <label className="field">
          Preço em centavos
          <input
            name="priceCents"
            type="number"
            min="1"
            defaultValue={product?.priceCents}
            required
            disabled={!owner}
          />
        </label>
        <label className="field">
          Status
          <select name="status" defaultValue={product?.status ?? 'DRAFT'} disabled={!owner}>
            {['DRAFT', 'ACTIVE', 'RESERVED', 'SOLD_OUT'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            name="featured"
            type="checkbox"
            defaultChecked={product?.featured}
            disabled={!owner}
          />{' '}
          Destaque
        </label>
        {owner && (
          <button className="btn btn-solid" disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar produto'}
          </button>
        )}
      </form>
      {product && (
        <>
          <h2>Variações e estoque</h2>
          {product.variants.map((variant) => (
            <form
              className="admin-variant"
              key={variant.id}
              onSubmit={(event) => stock(event, variant.id, variant.reserved)}
            >
              <span>
                {variant.sku} · {variant.size} · reservado {variant.reserved}
              </span>
              <label>
                Estoque
                <input name="stock" type="number" min="0" defaultValue={variant.stock} />
              </label>
              <button className="btn btn-ghost">Atualizar</button>
            </form>
          ))}
          {owner && (
            <form className="panel admin-form" onSubmit={addVariant}>
              <h3>Nova variação</h3>
              {(['sku', 'size', 'color', 'stock'] as const).map((field) => (
                <label className="field" key={field}>
                  {field}
                  <input
                    name={field}
                    type={field === 'stock' ? 'number' : 'text'}
                    required={field !== 'color'}
                  />
                </label>
              ))}
              <button className="btn btn-solid">Criar variação</button>
            </form>
          )}
        </>
      )}
      {notice && (
        <p className="alert ok" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
