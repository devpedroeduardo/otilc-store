'use client';

import Link from 'next/link';
import { useState } from 'react';
import { checkoutSchema, formatBRL, type OrderDto } from '@otilc/shared';
import { useCart } from './cart-context';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';

type FieldErrors = Partial<Record<'name' | 'email' | 'phone', string>>;

export function Checkout() {
  const { lines, subtotalCents, remove, clear, ready } = useCart();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [order, setOrder] = useState<OrderDto | null>(null);

  if (order) {
    const expires = new Date(order.expiresAt).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <div className="cart">
        <div className="panel" role="status">
          <span className="mono muted">Pedido nº {order.number}</span>
          <p className="alert ok">Pedido criado. Suas peças estão reservadas até as {expires}.</p>
          <ul className="cart-list">
            {order.items.map((i) => (
              <li
                key={i.variantId}
                className="cart-item"
                style={{ gridTemplateColumns: '1fr auto' }}
              >
                <span>
                  {i.productName} <span className="muted">· {i.size}</span>
                </span>
                <span className="price">{formatBRL(i.unitPriceCents * i.quantity)}</span>
              </li>
            ))}
          </ul>
          <div className="total">
            <span>Total</span>
            <span>{formatBRL(order.totalCents)}</span>
          </div>
          <p className="muted">
            O pagamento por Pix entra na próxima etapa do projeto. Por enquanto o pedido fica
            aguardando pagamento e o estoque volta para a loja quando o prazo vence.
          </p>
          <Link href="/" className="btn btn-ghost">
            Voltar ao catálogo
          </Link>
        </div>
      </div>
    );
  }

  if (!ready) return <p className="empty">Carregando o carrinho…</p>;

  if (lines.length === 0) {
    return (
      <div className="empty">
        <p>Seu carrinho está vazio.</p>
        <Link href="/" className="btn btn-ghost">
          Ver o catálogo
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
        setOrder(body as OrderDto);
        clear();
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
      <ul className="cart-list" aria-label="Itens no carrinho">
        {lines.map((l) => (
          <li key={l.variantId} className="cart-item">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {l.image ? <img src={l.image} alt="" width={88} height={110} /> : <span />}
            <div>
              <Link href={`/produto/${l.slug}`}>{l.name}</Link>
              <div className="mono muted">Tam. {l.size}</div>
              <button type="button" className="link-btn" onClick={() => remove(l.variantId)}>
                Remover
              </button>
            </div>
            <span className="price">{formatBRL(l.priceCents * l.quantity)}</span>
          </li>
        ))}
      </ul>

      <form className="panel" onSubmit={onSubmit} noValidate>
        <div className="total">
          <span>Subtotal</span>
          <span>{formatBRL(subtotalCents)}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          O valor final é confirmado pela loja ao criar o pedido.
        </p>

        {(
          [
            ['name', 'Nome', 'text', 'name'],
            ['email', 'E-mail', 'email', 'email'],
            ['phone', 'WhatsApp com DDD', 'tel', 'tel'],
          ] as const
        ).map(([name, label, type, autoComplete]) => (
          <div className="field" key={name}>
            <label htmlFor={name} className="mono muted">
              {label}
            </label>
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

        <button type="submit" className="btn btn-solid" disabled={sending}>
          {sending ? 'Criando pedido…' : 'Finalizar pedido'}
        </button>
      </form>
    </div>
  );
}
