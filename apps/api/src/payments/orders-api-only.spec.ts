import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

/**
 * A API de Pagamentos do Mercado Pago foi trocada pela de Orders (spec-021): nenhum arquivo de
 * `apps/api/src` pode voltar a citar a rota antiga, nem em comentário. Este arquivo só a escreve
 * dentro da regex, com as barras escapadas.
 */
describe('só a API de Orders do Mercado Pago', () => {
  it('nenhum arquivo de apps/api/src cita a rota da API de Pagamentos', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.ts$/.test(f),
    );
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) =>
      /\/v1\/payments/.test(readFileSync(join(SRC, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
