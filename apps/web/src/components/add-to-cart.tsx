'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ProductDetailDto } from '@otilc/shared';
import { useCart } from './cart-context';
import { ArrowIcon, BagIcon, CheckIcon } from './icons';

export function AddToCart({ product }: { product: ProductDetailDto }) {
  const { add, lines } = useCart();
  const options = product.variants;
  const firstAvailable = options.find((v) => v.available > 0);
  const [variantId, setVariantId] = useState(firstAvailable?.id ?? '');
  const [justAdded, setJustAdded] = useState(false);

  if (product.status !== 'ACTIVE' || !firstAvailable) {
    return (
      <p className="alert error" role="status">
        {product.status === 'RESERVED'
          ? 'Esta peça está reservada em um pedido aguardando pagamento.'
          : 'Esta peça já foi vendida.'}
      </p>
    );
  }

  const inCart = lines.some((l) => l.variantId === variantId);
  const selected = options.find((v) => v.id === variantId);

  return (
    <form
      className="buy"
      onSubmit={(e) => {
        e.preventDefault();
        if (!selected) return;
        add({
          variantId: selected.id,
          slug: product.slug,
          name: product.name,
          size: selected.size,
          priceCents: product.priceCents,
          image: product.images[0]?.url ?? null,
        });
        setJustAdded(true);
      }}
    >
      <fieldset className="sizes">
        <legend>Tamanho</legend>
        {options.map((v) => (
          <label key={v.id} className="size">
            <input
              type="radio"
              name="size"
              value={v.id}
              checked={variantId === v.id}
              disabled={v.available === 0}
              onChange={() => setVariantId(v.id)}
            />
            <span>{v.size}</span>
          </label>
        ))}
      </fieldset>
      {inCart ? (
        <Link href="/carrinho" className="btn btn-solid">
          Ver carrinho <ArrowIcon />
        </Link>
      ) : (
        <button type="submit" className="btn btn-solid" disabled={!selected}>
          <BagIcon /> Adicionar ao carrinho
        </button>
      )}
      <div aria-live="polite">
        {justAdded && inCart && (
          <p className="added">
            <CheckIcon /> Adicionada ao carrinho. Ela só fica reservada quando você finaliza o
            pedido.
          </p>
        )}
      </div>
    </form>
  );
}
