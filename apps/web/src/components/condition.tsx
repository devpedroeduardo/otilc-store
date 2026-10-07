/** Régua de condição de 0 a 10 para peças seminovas, igual à da vitrine da pré-venda. */
export function Condition({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="cond none">NOVO</span>;
  }
  const bars = Array.from({ length: 10 }, (_, i) => {
    if (value >= i + 1) return 'on';
    if (value > i) return 'half';
    return '';
  });
  return (
    <span className="cond" aria-label={`Condição ${value.toLocaleString('pt-BR')} de 10`}>
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
