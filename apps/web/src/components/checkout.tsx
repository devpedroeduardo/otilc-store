'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startTransition, useState } from 'react';
import { checkoutSchema, formatBRL, type OrderDto } from '@otilc/shared';
import { useCart } from './cart-context';
import { ArrowIcon, ClockIcon, ShieldIcon } from './icons';
import { ViewTransition } from './view-transition';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';

type FieldErrors = Partial<Record<'name' | 'email' | 'phone', string>>;

export function Checkout() {
  const router = useRouter();
  const { lines, subtotalCents, remove, clear, ready } = useCart();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [order, setOrder] = useState<OrderDto | null>(null);

  if (order) {
    return (
      <div className="empty-state" role="status">
        <span className="waiting">
          <span className="spinner" aria-hidden="true" />
          Pedido nº {order.number} criado. Levando você ao pagamento…
        </span>
      </div>
    );
  }

  if (!ready)
    return (
      <div className="cart" aria-busy="true">
        <div className="skeleton" style={{ height: 260 }} />
        <div className="skeleton" style={{ height: 420 }} />
        <span className="sr-only">Carregando o carrinho…</span>
      </div>
    );

  if (lines.length === 0) {
    return (
      <div className="empty-state">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-eye-static" src="/brand/eye.webp" alt="" width={900} height={712} />
        <h2>Seu carrinho está vazio</h2>
        <p>As peças são únicas. Quando uma te chamar a atenção, ela vem para cá.</p>
        <Link href="/#pecas" className="btn btn-solid">
          Ver o catálogo <ArrowIcon />
        </Link>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const form = new FormData(e.currentTarget);
    const input = {
      items: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      customer: {
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        phone: String(form.get('phone') ?? '').replace(/[^\d+]/g, ''),
      },
    };

    // Mesma validação da API (pacote @otilc/shared): o erro aparece antes de enviar.
    const parsed = checkoutSchema.safeParse(input);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[1] as keyof FieldErrors;
        if (issue.path[0] === 'customer' && field && !next[field]) next[field] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) {
        const created = body as OrderDto;
        setOrder(created);
        clear();
        router.push(`/pedido/${created.id}`);
      } else if (res.status === 409 || res.status === 422) {
        setMessage(
          `${body.message ?? 'Uma peça do carrinho não está mais disponível.'} Remova a peça e tente de novo.`,
        );
      } else if (res.status === 429) {
        setMessage('Muitas tentativas seguidas. Espere um minuto e tente de novo.');
      } else {
        setMessage('Não foi possível criar o pedido agora. Tente de novo em instantes.');
      }
    } catch {
      setMessage('Sem conexão com a loja. Verifique a internet e tente de novo.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="cart">
      <div>
        <ul className="cart-list" aria-label="Itens no carrinho">
          {lines.map((l) => (
            <ViewTransition key={l.variantId} exit="row-out" update="row-move" default="none">
              <li className="cart-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {l.image ? <img src={l.image} alt="" width={88} height={110} /> : <span />}
                <div className="details">
                  <Link href={`/produto/${l.slug}`} className="name">
                    {l.name}
                  </Link>
                  <span className="muted">Tamanho {l.size}</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => startTransition(() => remove(l.variantId))}
                  >
                    Remover
                  </button>
                </div>
                <span className="price">{formatBRL(l.priceCents * l.quantity)}</span>
              </li>
            </ViewTransition>
          ))}
        </ul>
        <p className="cart-note">
          <ClockIcon />
          <span>
            Ao finalizar, as peças ficam reservadas para você por 30 minutos enquanto o Pix não é
            pago. Depois disso voltam para a loja.
          </span>
        </p>
      </div>

      <form className="panel sticky" onSubmit={onSubmit} noValidate>
        <h2>Seus dados</h2>
        <p className="muted" style={{ margin: 0 }}>
          Usamos só para identificar o pedido e falar com você sobre ele.
        </p>

        {(
          [
            ['name', 'Nome', 'text', 'name'],
            ['email', 'E-mail', 'email', 'email'],
            ['phone', 'WhatsApp com DDD', 'tel', 'tel'],
          ] as const
        ).map(([name, label, type, autoComplete]) => (
          <div className="field" key={name}>
            <label htmlFor={name}>{label}</label>
            <input
              id={name}
              name={name}
              type={type}
              autoComplete={autoComplete}
              required
              aria-invalid={errors[name] ? true : undefined}
              aria-describedby={errors[name] ? `${name}-erro` : undefined}
            />
            {errors[name] && (
              <span id={`${name}-erro`} className="error">
                {errors[name]}
              </span>
            )}
          </div>
        ))}

        {message && (
          <p className="alert error" role="alert">
            {message}
          </p>
        )}

        <div className="total" style={{ paddingTop: 18, borderTop: '1px solid var(--line)' }}>
          <span>Subtotal</span>
          <span>{formatBRL(subtotalCents)}</span>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          O valor final é confirmado pela loja ao criar o pedido.
        </p>
        <button type="submit" className="btn btn-solid btn-block" disabled={sending}>
          {sending ? 'Criando pedido…' : 'Finalizar pedido'}
        </button>
        <p className="secure">
          <ShieldIcon /> Pagamento por Pix, processado pelo Mercado Pago
        </p>
      </form>
    </div>
  );
}
