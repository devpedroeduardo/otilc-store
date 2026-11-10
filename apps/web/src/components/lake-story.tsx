'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A história da marca contada pelo José Clito, em cena simbólica (sem desenhar o personagem):
 * a luz do Otilc vai de pedra em pedra até o lago, uma gota cai, um olho azul surge no reflexo,
 * fica prateado e sobe até virar a logo. Prata e azul. Toda a coreografia está no CSS
 * (`.story` em globals.css); aqui só se decide entre tocar e mostrar o quadro final.
 *
 * Toca na primeira visita. Depois (ou com prefers-reduced-motion) abre no quadro final,
 * com o botão "Ver de novo".
 */
const SEEN_KEY = 'otilc:historia-vista';
const DURATION_MS = 7200;

type Mode = 'idle' | 'play' | 'ended' | 'done';

const STARS = [
  [8, 9],
  [17, 22],
  [26, 6],
  [38, 15],
  [47, 4],
  [55, 27],
  [63, 11],
  [72, 20],
  [81, 7],
  [90, 17],
  [12, 38],
  [33, 33],
  [58, 40],
  [77, 34],
  [94, 42],
] as const;

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Sem armazenamento (modo privado): a história toca de novo na próxima visita.
  }
}

export function LakeStory() {
  const [mode, setMode] = useState<Mode>('idle');
  const [run, setRun] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const play = () => {
    clearTimeout(timer.current);
    setMode('play');
    setRun((n) => n + 1); // remonta a cena: as animações recomeçam do zero
    markSeen();
    timer.current = setTimeout(() => setMode('ended'), DURATION_MS);
  };

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || readSeen()) setMode('done');
    else play();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Antes de decidir (renderização no servidor), mostra só o céu e o lago.
  const cls = mode === 'idle' ? '' : mode === 'ended' ? 'play ended' : mode;

  return (
    <div className={`story ${cls}`} key={run}>
      <div className="sky" aria-hidden="true" />
      {STARS.map(([x, y], i) => (
        <span
          key={i}
          className="star"
          aria-hidden="true"
          style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${(i % 5) * 0.6}s` }}
        />
      ))}
      <div className="lake" aria-hidden="true" />
      <div className="shimmer" aria-hidden="true" />
      <div className="horizon" aria-hidden="true" />
      <div className="stones" aria-hidden="true" style={{ inset: 0 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="stone" style={{ position: 'absolute' }} />
        ))}
      </div>
      <span className="walker" aria-hidden="true" />
      <span className="drop" aria-hidden="true" />
      <span className="ripple" aria-hidden="true" />
      <span className="ripple r2" aria-hidden="true" />
      <span className="ripple r3" aria-hidden="true" />
      <div className="sweep" aria-hidden="true" />
      <div className="eye-fly" aria-hidden="true">
        <div className="open">
          {/* O olho azul do reflexo e, por cima, o mesmo olho prateado que aparece aos poucos. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="blue" src="/brand/eye.webp" alt="" width={900} height={712} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="silver" src="/brand/eye.webp" alt="" width={900} height={712} />
        </div>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="logo-reflex"
        src="/brand/logo.webp"
        alt=""
        width={1206}
        height={353}
        aria-hidden="true"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="logo" src="/brand/logo.webp" alt="OTILC" width={1206} height={353} />
      <button type="button" className="btn btn-ghost btn-sm replay" onClick={play}>
        Ver de novo
      </button>
    </div>
  );
}
