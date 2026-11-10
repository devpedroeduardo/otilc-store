'use client';

import { useState } from 'react';
import type { ProductImageDto } from '@otilc/shared';
import { ViewTransition } from './view-transition';

/** Foto grande com miniaturas ao lado e zoom que segue o mouse. */
export function Gallery({
  images,
  out,
  slug,
}: {
  images: ProductImageDto[];
  out: boolean;
  /** Mesmo nome da foto do card: a foto do card vira esta ao abrir a peça. */
  slug: string;
}) {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const current = images[index];
  if (!current) return <div className="gallery single" />;

  return (
    <div className={`gallery${images.length > 1 ? '' : ' single'}`}>
      {images.length > 1 && (
        <div className="thumbs" role="group" aria-label="Fotos da peça">
          {images.map((img, i) => (
            <button
              key={img.url}
              type="button"
              aria-label={`Ver foto ${i + 1} de ${images.length}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => setIndex(i)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" width={80} height={100} />
            </button>
          ))}
        </div>
      )}
      <figure
        className={`main${zoom ? ' zoom' : ''}${out ? ' out' : ''}`}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setZoom({
            x: ((e.clientX - box.left) / box.width) * 100,
            y: ((e.clientY - box.top) / box.height) * 100,
          });
        }}
        onMouseLeave={() => setZoom(null)}
      >
        <ViewTransition name={`photo-${slug}`} share="morph" default="none">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.url}
            alt={current.alt}
            width={800}
            height={1000}
            style={zoom ? { transformOrigin: `${zoom.x}% ${zoom.y}%` } : undefined}
          />
        </ViewTransition>
      </figure>
    </div>
  );
}
