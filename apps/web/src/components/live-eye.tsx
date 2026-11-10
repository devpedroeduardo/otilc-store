'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * O olho da logo OTILC, vivo. As imagens da marca (`public/brand/logo.webp`, `eye.webp`, ícones)
 * são capturas deste mesmo desenho, então a logo e o olho animado são iguais.
 *
 * Desenho: pálpebras e sobrancelha em tubo cromado, abertura escura e funda, e dentro dela um
 * globo de prata com a pupila preta envolta por um anel do mesmo tubo das pálpebras
 * (inspiração: o globo do Olho do Milênio, adaptado ao cromado e à forma amendoada da OTILC).
 *
 * Interação: o globo segue o ponteiro (mouse ou dedo) e a pupila anda um pouco mais que ele,
 * como uma esfera girando. Pisca sozinho e ao clicar. No `hero`, passar o mouse deixa o globo
 * azul por um instante e ele volta a prata, como na história da marca.
 * Com prefers-reduced-motion o olho fica parado, olhando para a frente.
 *
 * Desempenho: o cromado sai de filtros de luz do SVG, que são caros. Por isso o olho é uma pilha
 * de camadas (fundo, globo, pupila, pálpebras, sobrancelha), cada uma um SVG próprio desenhado
 * uma vez só. O movimento e a piscada usam apenas `transform`/`opacity` do CSS, que a GPU aplica
 * sem redesenhar nada: nenhum filtro roda de novo enquanto o olho se mexe.
 */

const VIEWBOX = { x: 20, y: -12, w: 472, h: 340 };
const VB = `${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`;

const UPPER = 'M30 190 C110 36 402 36 482 190 C400 100 112 100 30 190Z';
const LOWER = 'M30 190 C112 280 400 280 482 190 C402 350 110 350 30 190Z';
const BROW = 'M84 128 C160 -6 352 -6 428 128 C352 36 160 36 84 128Z';
/** Abertura do olho (bordas internas das pálpebras): o globo só aparece aqui dentro. */
const OPENING = 'M30 190 C112 100 400 100 482 190 C400 282 112 282 30 190Z';
const RING =
  'M256 146 a44 44 0 1 1 0 88 a44 44 0 1 1 0 -88Z M256 160 a30 30 0 1 0 0 60 a30 30 0 1 0 0 -60Z';

/** Máscara da abertura, na mesma escala das camadas (o viewBox estica junto com o elemento). */
const OPENING_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" preserveAspectRatio="none"><path d="${OPENING}"/></svg>`,
)}")`;

/** Quanto o globo anda dentro da abertura (unidades do viewBox); a pupila anda PUPIL vezes isso. */
const REACH = { hero: { x: 58, y: 16 }, mark: { x: 50, y: 12 } } as const;
const PUPIL = 1.45;
/** Fração do caminho até o alvo percorrida a cada 1/60 s (corrigida pelo tempo real do quadro). */
const EASE = 0.14;

type Variant = keyof typeof REACH;

/** Cromado em tubo: desfoque do contorno vira relevo, com faixas de reflexo cinza neutro. */
function ChromeFilter({ id, blur, height }: { id: string; blur: number; height: number }) {
  const tone = '0.16 0.42 0.20 0.62 0.34 0.90';
  return (
    <filter id={id} x="-10%" y="-20%" width="120%" height="140%" colorInterpolationFilters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation={blur} result="b" />
      <feDiffuseLighting
        in="b"
        surfaceScale={height}
        diffuseConstant="1.05"
        lightingColor="#fff"
        result="d"
      >
        <feDistantLight azimuth="250" elevation="34" />
      </feDiffuseLighting>
      <feComponentTransfer in="d" result="band">
        <feFuncR type="table" tableValues={tone} />
        <feFuncG type="table" tableValues={tone} />
        <feFuncB type="table" tableValues="0.154 0.403 0.192 0.595 0.326 0.864" />
      </feComponentTransfer>
      <feSpecularLighting
        in="b"
        surfaceScale={height}
        specularConstant="1.1"
        specularExponent="40"
        lightingColor="#fff"
        result="s"
      >
        <feDistantLight azimuth="225" elevation="50" />
      </feSpecularLighting>
      <feComposite in="band" in2="s" operator="arithmetic" k2="1" k3="0.55" result="c" />
      <feComposite in="c" in2="SourceAlpha" operator="in" />
    </filter>
  );
}

/** Uma camada do olho: um SVG do tamanho do olho inteiro, com o mesmo viewBox das outras. */
function Layer({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg className={`le-layer ${className}`} viewBox={VB} focusable="false">
      {children}
    </svg>
  );
}

/** Globo de prata (ou azul): faixas de reflexo, borda escura e um brilho no alto à esquerda. */
function Globe({ id, stops }: { id: (n: string) => string; stops: string[] }) {
  const offsets = [0, 0.28, 0.47, 0.53, 0.62, 0.84, 1];
  return (
    <>
      <defs>
        <linearGradient id={id('globe')} x1="0.35" y1="0" x2="0.65" y2="1">
          {offsets.map((o, i) => (
            <stop key={o} offset={o} stopColor={stops[i]} />
          ))}
        </linearGradient>
        <radialGradient id={id('edge')} cx=".5" cy=".5" r=".5">
          <stop offset=".62" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".6" />
        </radialGradient>
        <radialGradient id={id('shine')} cx=".34" cy=".26" r=".34">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="256" cy="190" r="74" fill={`url(#${id('globe')})`} />
      <circle cx="256" cy="190" r="74" fill={`url(#${id('edge')})`} />
      <circle cx="256" cy="190" r="74" fill={`url(#${id('shine')})`} />
    </>
  );
}

const SILVER = ['#f4f4f1', '#b9b9b6', '#4a4a4c', '#2a2a2c', '#7c7c7b', '#e2e2df', '#9a9a97'];
const BLUE = ['#eef4ff', '#8fb4ff', '#1f4fb8', '#0f2a6e', '#4f7fe0', '#cfe0ff', '#7f9fd8'];

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function LiveEye({
  variant = 'hero',
  className,
}: {
  variant?: Variant;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<HTMLDivElement>(null);
  const pupilRef = useRef<HTMLDivElement>(null);
  const [blinking, setBlinking] = useState(false);
  const [blue, setBlue] = useState(false);

  // Globo seguindo o ponteiro. O evento só guarda a posição; o cálculo e a escrita do transform
  // acontecem uma vez por quadro, no requestAnimationFrame.
  useEffect(() => {
    const root = rootRef.current;
    const globe = globeRef.current;
    const pupil = pupilRef.current;
    if (!root || !globe || !pupil || reducedMotion()) return;
    const reach = REACH[variant];
    const pos = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0, fresh: false };
    let lastMove = -Infinity;
    let lastFrame = 0;
    let frame = 0;
    let visible = true;
    let rect = root.getBoundingClientRect();
    const measure = () => {
      rect = root.getBoundingClientRect();
    };

    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.fresh = true;
      lastMove = performance.now();
    };

    const tick = (now: number) => {
      const dt = lastFrame ? Math.min(64, now - lastFrame) : 16.7;
      lastFrame = now;
      if (pointer.fresh) {
        pointer.fresh = false;
        const dx = pointer.x - (rect.left + rect.width / 2);
        const dy = pointer.y - (rect.top + rect.height * 0.594);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / Math.max(220, rect.width * 0.9));
        target.x = (dx / d) * k * reach.x;
        target.y = (dy / d) * k * reach.y;
      } else if (variant === 'hero' && now - lastMove > 2500) {
        // Sem o ponteiro por 2,5 s, o olho do topo passeia devagar.
        const t = now / 1000;
        target.x = Math.sin(t * 0.7) * reach.x * 0.6;
        target.y = Math.sin(t * 1.1) * reach.y * 0.5;
      }
      const a = 1 - Math.pow(1 - EASE, dt / 16.7);
      const stepX = (target.x - pos.x) * a;
      const stepY = (target.y - pos.y) * a;
      // Já no alvo: não escreve nada, então um olho parado não custa nada ao navegador.
      if (Math.abs(stepX) < 0.005 && Math.abs(stepY) < 0.005) {
        frame = visible ? requestAnimationFrame(tick) : 0;
        return;
      }
      pos.x += stepX;
      pos.y += stepY;
      // Unidades do viewBox para pixels da tela.
      const s = rect.width / VIEWBOX.w;
      globe.style.transform = `translate3d(${(pos.x * s).toFixed(2)}px, ${(pos.y * s).toFixed(2)}px, 0)`;
      pupil.style.transform = `translate3d(${(pos.x * (PUPIL - 1) * s).toFixed(2)}px, ${(pos.y * (PUPIL - 1) * s).toFixed(2)}px, 0)`;
      frame = visible ? requestAnimationFrame(tick) : 0;
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible && !frame) {
        lastFrame = 0;
        measure();
        frame = requestAnimationFrame(tick);
      }
    });
    const ro = new ResizeObserver(measure);
    io.observe(root);
    ro.observe(root);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    window.addEventListener('scroll', measure, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      io.disconnect();
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('scroll', measure);
      cancelAnimationFrame(frame);
    };
  }, [variant]);

  // Piscada automática, num intervalo irregular.
  useEffect(() => {
    if (reducedMotion()) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setBlinking(true);
          setTimeout(() => setBlinking(false), 160);
          schedule();
        },
        2800 + Math.random() * 3800,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  const blink = () => {
    if (reducedMotion()) return;
    setBlinking(true);
    setTimeout(() => setBlinking(false), 160);
  };
  const flashBlue = () => {
    if (variant !== 'hero' || reducedMotion()) return;
    setBlue(true);
    setTimeout(() => setBlue(false), 900);
  };

  const id = (name: string) => `${name}${uid}`;

  return (
    <div
      ref={rootRef}
      className={[
        'live-eye',
        `live-eye-${variant}`,
        blinking && 'is-blinking',
        blue && 'is-blue',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
      onPointerEnter={flashBlue}
      onClick={() => {
        blink();
        flashBlue();
      }}
    >
      <div className="le-blink">
        <Layer className="le-pit">
          <defs>
            <radialGradient id={id('pit')} cx="50%" cy="45%" r="60%">
              <stop offset="0" stopColor="#16171a" />
              <stop offset="1" stopColor="#030304" />
            </radialGradient>
          </defs>
          <path d={OPENING} fill={`url(#${id('pit')})`} />
        </Layer>

        <div
          className="le-opening"
          style={{ maskImage: OPENING_MASK, WebkitMaskImage: OPENING_MASK }}
        >
          <div ref={globeRef} className="le-move">
            <Layer className="le-globe">
              <defs>
                <filter id={id('soft')}>
                  <feGaussianBlur stdDeviation="6" />
                </filter>
              </defs>
              <circle
                cx="256"
                cy="196"
                r="76"
                fill="#000"
                opacity=".55"
                filter={`url(#${id('soft')})`}
              />
              <Globe id={(n) => id(`s${n}`)} stops={SILVER} />
            </Layer>
            {variant === 'hero' && (
              <Layer className="le-globe-blue">
                <Globe id={(n) => id(`b${n}`)} stops={BLUE} />
              </Layer>
            )}
            <div ref={pupilRef} className="le-move">
              <Layer className="le-pupil">
                <defs>
                  <ChromeFilter id={id('ring')} blur={4.5} height={7} />
                  <radialGradient id={id('pupil')} cx=".45" cy=".4" r=".6">
                    <stop offset="0" stopColor="#1b1c1f" />
                    <stop offset=".8" stopColor="#030304" />
                    <stop offset="1" stopColor="#000" />
                  </radialGradient>
                </defs>
                <circle cx="256" cy="190" r="30" fill={`url(#${id('pupil')})`} />
                <path d={RING} fillRule="evenodd" filter={`url(#${id('ring')})`} />
                <ellipse
                  cx="247"
                  cy="180"
                  rx="6"
                  ry="3.6"
                  fill="#fff"
                  opacity=".75"
                  transform="rotate(-25 247 180)"
                />
              </Layer>
            </div>
          </div>
        </div>

        <Layer className="le-lids">
          <defs>
            <ChromeFilter id={id('tube')} blur={10} height={14} />
            {/* Sombra desenhada dentro do SVG (fica na imagem da camada). Um drop-shadow do CSS
                seria refeito a cada quadro e travava o movimento do globo. */}
            <filter id={id('shadow')} x="-20%" y="-30%" width="140%" height="170%">
              <feGaussianBlur stdDeviation="12" />
            </filter>
          </defs>
          {variant === 'hero' && (
            <g transform="translate(0 20)" opacity=".5" filter={`url(#${id('shadow')})`}>
              <path d={UPPER} />
              <path d={LOWER} />
            </g>
          )}
          <g filter={`url(#${id('tube')})`}>
            <path d={UPPER} />
            <path d={LOWER} />
          </g>
        </Layer>
      </div>

      <Layer className="le-brow">
        <defs>
          <ChromeFilter id={id('brow')} blur={10} height={14} />
        </defs>
        {variant === 'hero' && (
          <path
            d={BROW}
            transform="translate(0 20)"
            opacity=".5"
            filter={`url(#${id('shadow')})`}
          />
        )}
        <path d={BROW} filter={`url(#${id('brow')})`} />
      </Layer>
    </div>
  );
}

/** A logo do cabeçalho e do rodapé: o olho vivo, pequeno, ao lado das letras TILC. */
export function LogoMark({ height = 28 }: { height?: number }) {
  return (
    <span className="logo-mark" style={{ height }}>
      <LiveEye variant="mark" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/tilc.webp" alt="OTILC" width={309} height={120} />
    </span>
  );
}
