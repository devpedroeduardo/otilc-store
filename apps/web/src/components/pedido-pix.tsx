'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBRL, pixErrorMessages, type PixChargeDto } from '@otilc/shared';
import { createPixCharge, getPixCharge, type PixResult } from '@/lib/api';
import { AlertIcon, CheckIcon, ClockIcon, CopyIcon } from './icons';

const POLL_MS = 5_000;
/** Prazo da reserva do pedido, usado só para a barra de tempo. */
const RESERVATION_MS = 30 * 60_000;

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

  // Criação em andamento: o ref sobrevive ao remount simulado do StrictMode (o estado também),
  // então o efeito que roda duas vezes e os cliques repetidos viram um único POST /pix.
  const creating = useRef(false);

  const start = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    setView({ kind: 'loading' });
    try {
      const result = await createPixCharge(orderId);
      let next = toView(result);
      if (result.kind === 'error' && result.code === 'ORDER_NOT_PAYABLE') {
        // Pedido já pago, cancelado ou vencido: a cobrança mais recente diz qual.
        const latest = await getPixCharge(orderId);
        next = latest.kind === 'charge' ? toView(latest) : { kind: 'notPayable' };
      }
      setView(next);
    } finally {
      creating.current = false;
    }
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

  if (view.kind === 'loading')
    return (
      <div className="pay" aria-busy="true">
        <div className="skeleton" style={{ height: 380 }} />
        <div className="skeleton" style={{ height: 380 }} />
        <span className="waiting" style={{ gridColumn: '1 / -1' }}>
          <span className="spinner" aria-hidden="true" />
          Gerando o Pix…
        </span>
      </div>
    );

  if (view.kind === 'unavailable') {
    return (
      <div className="pay">
        <div className="panel result bad">
          <span className="badge-icon">
            <AlertIcon />
          </span>
          <h2>Pix indisponível</h2>
          <p className="alert error" role="alert">
            {pixErrorMessages.PIX_UNAVAILABLE}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Seu pedido continua reservado até o fim do prazo.
          </p>
          <button type="button" className="btn btn-solid" onClick={() => void start()}>
            Tentar de novo
          </button>
          {backLink}
        </div>
      </div>
    );
  }

  if (view.kind === 'notFound') {
    return (
      <div className="pay">
        <div className="panel result bad">
          <p className="alert error" role="alert">
            Não encontramos este pedido.
          </p>
          {backLink}
        </div>
      </div>
    );
  }

  if (view.kind === 'notPayable') {
    return (
      <div className="pay">
        <div className="panel result bad">
          <span className="badge-icon">
            <ClockIcon />
          </span>
          <h2>Pedido expirado</h2>
          <p className="alert error" role="alert">
            {pixErrorMessages.ORDER_NOT_PAYABLE}
          </p>
          {backLink}
        </div>
      </div>
    );
  }

  if (view.kind === 'failed') {
    return (
      <div className="pay">
        <div className="panel result bad">
          <p className="alert error" role="alert">
            {view.message}
          </p>
          <button type="button" className="btn btn-solid" onClick={() => void start()}>
            Tentar de novo
          </button>
          {backLink}
        </div>
      </div>
    );
  }

  const { charge: c } = view;

  if (paid) {
    return (
      <div className="pay">
        <div className="panel result ok" role="status">
          <span className="badge-icon">
            <CheckIcon />
          </span>
          <h2>Pagamento confirmado</h2>
          <p className="alert ok">Recebemos o seu Pix de {formatBRL(c.amountCents)}. Obrigado!</p>
          <p className="muted" style={{ margin: 0 }}>
            A peça agora é sua. Guarde o link desta página para consultar o pedido.
          </p>
          {backLink}
        </div>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="pay">
        <div className="panel result bad" role="status">
          <span className="badge-icon">
            <ClockIcon />
          </span>
          <h2>Pedido expirado</h2>
          <p className="alert error">{pixErrorMessages.ORDER_NOT_PAYABLE}</p>
          {backLink}
        </div>
      </div>
    );
  }

  if (failedCharge) {
    return (
      <div className="pay">
        <div className="panel result bad">
          <span className="badge-icon">
            <AlertIcon />
          </span>
          <h2>Pagamento não concluído</h2>
          <p className="alert error" role="alert">
            O Pix não foi concluído. Você ainda pode gerar um novo dentro do prazo.
          </p>
          <button type="button" className="btn btn-solid" onClick={() => void start()}>
            Gerar novo Pix
          </button>
          {backLink}
        </div>
      </div>
    );
  }

  const share = Math.min(1, Math.max(0, remaining / RESERVATION_MS));

  return (
    <div className="pay">
      <div className="panel">
        <h2>Aguardando pagamento</h2>
        <div className="total">
          <span>Total</span>
          <span>{formatBRL(c.amountCents)}</span>
        </div>
        <div className={`countdown${remaining < 5 * 60_000 ? ' late' : ''}`}>
          <p>
            Tempo restante para pagar: <time>{formatRemaining(remaining)}</time>
          </p>
          <div className="meter" aria-hidden="true">
            <i style={{ width: `${share * 100}%` }} />
          </div>
        </div>
        <span className="waiting">
          <span className="spinner" aria-hidden="true" />A confirmação aparece aqui sozinha.
        </span>
        <ol className="how-to">
          <li>Abra o app do seu banco e escolha pagar com Pix.</li>
          <li>Leia o QR code ou cole o código copia e cola.</li>
          <li>Confira o valor e confirme. Não feche esta página.</li>
        </ol>
      </div>
      <div className="panel">
        <div className="qr">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/png;base64,${c.qrCodeBase64}`}
            alt="QR code do Pix"
            width={240}
            height={240}
          />
        </div>
        <div className="field">
          <label htmlFor="pix-code">Pix copia e cola</label>
          <div className="copy-row">
            <input
              id="pix-code"
              readOnly
              value={c.qrCode}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn btn-solid" onClick={() => void copy(c.qrCode)}>
              <CopyIcon /> Copiar
            </button>
          </div>
        </div>
        <span role="status" className={copied === 'ok' ? 'added' : 'muted'}>
          {copied === 'ok' && 'Código copiado.'}
          {copied === 'fail' && 'Não foi possível copiar. Selecione o código e copie manualmente.'}
        </span>
      </div>
    </div>
  );
}
