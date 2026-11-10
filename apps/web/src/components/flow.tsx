import { CheckIcon } from './icons';

const STEPS = ['Carrinho', 'Seus dados', 'Pagamento Pix'] as const;

/** Etapas da compra. `current` começa em 0. */
export function Flow({ current }: { current: number }) {
  return (
    <ol className="flow" aria-label="Etapas da compra">
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={i < current ? 'done' : undefined}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="n">{i < current ? <CheckIcon /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}
