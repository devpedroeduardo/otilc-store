'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatBRL, pixErrorMessages, type PixChargeDto } from '@otilc/shared';
import { createPixCharge, getPixCharge, type PixResult } from '@/lib/api';

const POLL_MS = 5_000;

type View =
  | { kind: 'loading' }
  | { kind: 'charge'; charge: PixChargeDto }
  | { kind: 'unavailable' }
  | { kind: 'notPayable' }
  | { kind: 'notFound' }
  | { kind: 'failed'; message: string };

/** Traduz o resultado de uma chamada ao Pix na tela que o cliente deve ver. */
function toView(result: PixResult): View {
  if (result.kind === 'charge') return { kind: 'charge', charge: result.charge };
  switch (result.code) {
    case 'PIX_UNAVAILABLE':
      return { kind: 'unavailable' };
    case 'ORDER_NOT_PAYABLE':
      return { kind: 'notPayable' };
    case 'NOT_FOUND':
      return { kind: 'notFound' };
    case 'RATE_LIMITED':
      return {
        kind: 'failed',
        message: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.',
      };
    default:
      return {
        kind: 'failed',
        message: 'Não foi possível carregar o pagamento agora. Tente de novo.',
      };
  }
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function PedidoPix({ orderId }: { orderId: string }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  const start = useCallback(async () => {
    setView({ kind: 'loading' });
    const result = await createPixCharge(orderId);
    if (result.kind === 'error' && result.code === 'ORDER_NOT_PAYABLE') {
      // Pedido já pago, cancelado ou vencido: a cobrança mais recente diz qual.
      const latest = await getPixCharge(orderId);
      setView(latest.kind === 'charge' ? toView(latest) : { kind: 'notPayable' });
      return;
    }
    setView(toView(result));
  }, [orderId]);

  useEffect(() => {
    void start();
  }, [start]);

  const charge = view.kind === 'charge' ? view.charge : null;
  const paid = charge?.orderStatus === 'PAID' || charge?.orderStatus === 'SHIPPED';
  const expiresAtMs = charge ? new Date(charge.expiresAt).getTime() : 0;
  const remaining = expiresAtMs - now;
  const expired = !!charge && !paid && (charge.orderStatus !== 'PENDING_PAYMENT' || remaining <= 0);
  const failedCharge =
    !!charge &&
    !paid &&
    !expired &&
    (charge.status === 'REJECTED' || charge.status === 'CANCELLED' || charge.status === 'REFUNDED');
  const waiting = !!charge && !paid && !expired && !failedCharge;

  // Contagem regressiva: só roda enquanto aguarda o pagamento.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);

  // Consulta a cada 5 s enquanto pendente; para em estado final ou ao vencer a contagem.
  useEffect(() => {
    if (!waiting) return;
    let active = true;
    const timer = setInterval(async () => {
      const result = await getPixCharge(orderId);
      // Falha numa consulta é passageira: mantém a tela e tenta na próxima.
      if (active && result.kind === 'charge') setView({ kind: 'charge', charge: result.charge });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [waiting, orderId]);

  // Uma última consulta ao vencer: um pagamento feito no limite ainda pode ter sido confirmado.
  const finalCheck =
    !!charge && !paid && charge.orderStatus === 'PENDING_PAYMENT' && remaining <= 0;
  useEffect(() => {
    if (!finalCheck) return;
    let active = true;
    void getPixCharge(orderId).then((result) => {
      if (active && result.kind === 'charge') setView({ kind: 'charge', charge: result.charge });
    });
    return () => {
      active = false;
    };
  }, [finalCheck, orderId]);

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  const backLink = (
    <Link href="/" className="btn btn-ghost">
      Voltar ao catálogo
    </Link>
  );

  if (view.kind === 'loading') return <p className="empty">Gerando o Pix…</p>;

  if (view.kind === 'unavailable') {
    return (
      <div className="panel">
        <h2>Pix indisponível</h2>
        <p className="alert error" role="alert">
          {pixErrorMessages.PIX_UNAVAILABLE}
        </p>
        <p className="muted">Seu pedido continua reservado até o fim do prazo.</p>
        <button type="button" className="btn btn-solid" onClick={() => void start()}>
          Tentar de novo
        </button>
        {backLink}
      </div>
    );
  }

  if (view.kind === 'notFound') {
    return (
      <div className="panel">
        <p className="alert error" role="alert">
          Não encontramos este pedido.
        </p>
        {backLink}
      </div>
    );
  }

  if (view.kind === 'notPayable') {
    return (
      <div className="panel">
        <h2>Pedido expirado</h2>
        <p className="alert error" role="alert">
          {pixErrorMessages.ORDER_NOT_PAYABLE}
        </p>
        {backLink}
      </div>
    );
  }

  if (view.kind === 'failed') {
    return (
      <div className="panel">
        <p className="alert error" role="alert">
          {view.message}
        </p>
        <button type="button" className="btn btn-solid" onClick={() => void start()}>
          Tentar de novo
        </button>
        {backLink}
      </div>
    );
  }

  const { charge: c } = view;

  if (paid) {
    return (
      <div className="panel" role="status">
        <h2>Pagamento confirmado</h2>
        <p className="alert ok">Recebemos o seu Pix de {formatBRL(c.amountCents)}. Obrigado!</p>
        {backLink}
      </div>
    );
  }

  if (expired) {
    return (
      <div className="panel" role="status">
        <h2>Pedido expirado</h2>
        <p className="alert error">{pixErrorMessages.ORDER_NOT_PAYABLE}</p>
        {backLink}
      </div>
    );
  }

  if (failedCharge) {
    return (
      <div className="panel">
        <h2>Pagamento não concluído</h2>
        <p className="alert error" role="alert">
          O Pix não foi concluído. Você ainda pode gerar um novo dentro do prazo.
        </p>
        <button type="button" className="btn btn-solid" onClick={() => void start()}>
          Gerar novo Pix
        </button>
        {backLink}
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Aguardando pagamento</h2>
      <div className="total">
        <span>Total</span>
        <span>{formatBRL(c.amountCents)}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Pague com o app do seu banco lendo o QR code ou usando o código copia e cola. A confirmação
        aparece aqui sozinha.
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`data:image/png;base64,${c.qrCodeBase64}`}
        alt="QR code do Pix"
        width={240}
        height={240}
        style={{ alignSelf: 'center', background: '#fff', padding: 8, borderRadius: 8 }}
      />
      <div className="field">
        <label htmlFor="pix-code" className="mono muted">
          Pix copia e cola
        </label>
        <input id="pix-code" readOnly value={c.qrCode} onFocus={(e) => e.currentTarget.select()} />
      </div>
      <button type="button" className="btn btn-solid" onClick={() => void copy(c.qrCode)}>
        Copiar
      </button>
      <span role="status" className="muted">
        {copied === 'ok' && 'Código copiado.'}
        {copied === 'fail' && 'Não foi possível copiar. Selecione o código e copie manualmente.'}
      </span>
      <p className="mono" style={{ margin: 0 }}>
        Tempo restante para pagar: <time>{formatRemaining(remaining)}</time>
      </p>
    </div>
  );
}
