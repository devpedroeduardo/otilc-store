/** Régua de condição de 0 a 10 para peças seminovas, igual à da vitrine da pré-venda. */
export function Condition({ value, large }: { value: number | null; large?: boolean }) {
  if (value === null) {
    return <span className="cond none">NOVO</span>;
  }
  const bars = Array.from({ length: 10 }, (_, i) => {
    if (value >= i + 1) return 'on';
    if (value > i) return 'half';
    return '';
  });
  return (
    <span
      className={`cond${large ? ' lg' : ''}`}
      aria-label={`Condição ${value.toLocaleString('pt-BR')} de 10`}
    >
      <span className="bar" aria-hidden="true">
        {bars.map((cls, i) => (
          <i key={i} className={cls} />
        ))}
      </span>
      {value.toLocaleString('pt-BR')}
      <small className="muted">/10</small>
    </span>
  );
}

/** Leitura da nota de condição em palavras, para quem não conhece a régua. */
export function conditionLabel(value: number | null): string {
  if (value === null) return 'Nova, sem uso';
  if (value >= 9) return 'Quase sem sinais de uso';
  if (value >= 7) return 'Pouco usada, bem conservada';
  if (value >= 5) return 'Sinais de uso visíveis';
  return 'Bastante usada, ver fotos';
}
