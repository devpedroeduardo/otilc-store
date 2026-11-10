'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  adminProductInputSchema,
  adminProductPatchSchema,
  adminVariantInputSchema,
  adminStockUpdateSchema,
  canRole,
  formatBRL,
  type AdminProductDto,
  type AdminRole,
  type ProductListItemDto,
} from '@otilc/shared';
import { adminApi, AdminApiError } from '@/lib/admin-api';
import { conditionLabel } from '@/components/condition';
import { ProductCard } from '@/components/product-card';
import { PRODUCT_STATUSES, ProductStatus, productStatusLabel } from './status';

type Draft = Pick<
  ProductListItemDto,
  'slug' | 'name' | 'brand' | 'priceCents' | 'condition' | 'status' | 'featured'
> & { categorySlug: string };

/** Lê o formulário para a prévia. A validação de verdade continua no Zod, ao salvar. */
function readDraft(form: HTMLFormElement): Draft {
  const data = new FormData(form);
  const text = (key: string) => String(data.get(key) ?? '').trim();
  const status = text('status');
  return {
    slug: text('slug'),
    name: text('name'),
    brand: text('brand') || null,
    priceCents: Number(text('priceCents')),
    condition: text('condition') === '' ? null : Number(text('condition')),
    status: (PRODUCT_STATUSES.includes(status) ? status : 'DRAFT') as Draft['status'],
    featured: data.get('featured') === 'on',
    categorySlug: text('categorySlug'),
  };
}
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
  const [draft, setDraft] = useState<Draft>({
    slug: product?.slug ?? '',
    name: product?.name ?? '',
    brand: product?.brand ?? null,
    priceCents: product?.priceCents ?? 0,
    condition: product?.condition ?? null,
    status: product?.status ?? 'DRAFT',
    featured: product?.featured ?? false,
    categorySlug: product?.category.slug ?? '',
  });
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
      condition: data.get('condition') === '' ? null : Number(data.get('condition')),
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
  async function stock(event: React.FormEvent<HTMLFormElement>, id: string) {
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
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 401) {
        router.replace('/admin/login');
        router.refresh();
        return;
      }
      if (e instanceof AdminApiError && e.status === 409) {
        setError(e.message);
        return;
      }
      setError('Não foi possível atualizar o estoque. Tente novamente.');
    }
  }
  const preview: ProductListItemDto = {
    slug: draft.slug || 'nova-peca',
    name: draft.name || 'Nome da peça',
    brand: draft.brand || null,
    priceCents: Number.isFinite(draft.priceCents) ? draft.priceCents : 0,
    condition: draft.condition,
    status: draft.status,
    featured: draft.featured,
    category: product?.category ?? { slug: draft.categorySlug, name: draft.categorySlug || '-' },
    image: product?.images[0] ?? null,
    sizes: product?.variants.map((v) => v.size) ?? [],
  };
  return (
    <>
      <div className="editor">
        <div>
          <form
            className="card-box admin-form"
            onSubmit={save}
            onChange={(e) => setDraft(readDraft(e.currentTarget))}
          >
            <fieldset>
              <legend>Informações</legend>
              <label className="field">
                Nome
                <input name="name" defaultValue={product?.name} required disabled={!owner} />
              </label>
              <div className="field">
                <label className="field">
                  Slug
                  <input name="slug" defaultValue={product?.slug} required disabled={!owner} />
                </label>
                <span className="hint">Endereço da peça: /produto/{draft.slug || '…'}</span>
              </div>
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
            </fieldset>
            <fieldset>
              <legend>Descrição</legend>
              <label className="field full">
                Descrição
                <textarea
                  name="description"
                  defaultValue={product?.description ?? ''}
                  disabled={!owner}
                />
              </label>
              <div className="field full">
                <label className="field">
                  Observação
                  <input name="note" defaultValue={product?.note ?? ''} disabled={!owner} />
                </label>
                <span className="hint">Aparece em itálico na página da peça.</span>
              </div>
            </fieldset>
            <fieldset>
              <legend>Preço e condição</legend>
              <div className="field">
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
                <span className="hint">
                  Na loja: {formatBRL(Number.isFinite(draft.priceCents) ? draft.priceCents : 0)}
                </span>
              </div>
              <div className="field">
                <label className="field">
                  Condição (0 a 10)
                  <input
                    name="condition"
                    type="number"
                    min="0"
                    max="10"
                    step="0.1"
                    defaultValue={product?.condition ?? ''}
                    disabled={!owner}
                  />
                </label>
                <span className="hint">
                  Vazio para peça nova. {conditionLabel(draft.condition)}.
                </span>
              </div>
            </fieldset>
            <fieldset>
              <legend>Publicação</legend>
              <label className="field">
                Status
                <select name="status" defaultValue={product?.status ?? 'DRAFT'} disabled={!owner}>
                  {PRODUCT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {productStatusLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="switch" style={{ alignSelf: 'end', paddingBottom: 10 }}>
                <input
                  name="featured"
                  type="checkbox"
                  defaultChecked={product?.featured}
                  disabled={!owner}
                />
                Destaque
              </label>
            </fieldset>
            <div className="form-foot">
              {owner ? (
                <button className="btn btn-solid" disabled={busy}>
                  {busy ? 'Salvando…' : 'Salvar produto'}
                </button>
              ) : (
                <span className="hint">
                  Seu acesso é de equipe: você ajusta estoque, mas não edita a peça.
                </span>
              )}
            </div>
          </form>
        </div>

        <div className="aside">
          <section className="card-box" aria-labelledby="titulo-previa">
            <header>
              <h2 id="titulo-previa">Prévia na loja</h2>
              <ProductStatus status={draft.status} />
            </header>
            <div className="body preview" aria-hidden="true">
              <ProductCard product={preview} morph={false} />
            </div>
          </section>

          {product && (
            <section className="card-box">
              <header>
                <h2>Variações e estoque</h2>
              </header>
              {product.variants.length === 0 && (
                <p className="hint" style={{ padding: '16px 20px', margin: 0 }}>
                  Sem variações. Crie uma para a peça poder ser vendida.
                </p>
              )}
              {product.variants.map((variant) => (
                <form
                  className="admin-variant"
                  key={variant.id}
                  onSubmit={(event) => stock(event, variant.id)}
                >
                  <span className="what">
                    <strong>{variant.sku}</strong>
                    <span className="muted">
                      Tamanho {variant.size}
                      {variant.color ? `, ${variant.color}` : ''} · {variant.reserved} reservado
                    </span>
                  </span>
                  <label>
                    Estoque
                    <input name="stock" type="number" min="0" defaultValue={variant.stock} />
                  </label>
                  <button className="btn btn-ghost btn-sm">Atualizar</button>
                </form>
              ))}
              {owner && (
                <form className="new-variant" onSubmit={addVariant}>
                  <h3>Nova variação</h3>
                  {(
                    [
                      ['sku', 'SKU', 'text', true],
                      ['size', 'Tamanho', 'text', true],
                      ['color', 'Cor (opcional)', 'text', false],
                      ['stock', 'Quantidade inicial', 'number', true],
                    ] as const
                  ).map(([field, label, type, required]) => (
                    <label className="field" key={field}>
                      {label}
                      <input
                        name={field}
                        type={type}
                        min={type === 'number' ? 0 : undefined}
                        required={required}
                      />
                    </label>
                  ))}
                  <button className="btn btn-ghost btn-sm">Criar variação</button>
                </form>
              )}
            </section>
          )}
        </div>
      </div>
      <div className="toast-area">
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
      </div>
    </>
  );
}
