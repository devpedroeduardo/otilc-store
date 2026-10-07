import { loadEnv } from './env';

describe('loadEnv', () => {
  it('aplica valores padrão', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://u@localhost:5432/db' });
    expect(env.PORT).toBe(3333);
    expect(env.ORDER_HOLD_MINUTES).toBe(30);
  });

  it('não sobe sem DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
