import { randomBytes } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolConfig } from 'pg';
import { poolConfig } from './client';
import { runMigrations } from './migrate';

// O migrator não conecta de verdade: o teste só olha a configuração que chega ao Pool.
const created: PoolConfig[] = [];
jest.mock('pg', () => ({
  Pool: class {
    constructor(config: PoolConfig) {
      created.push(config);
    }
    end = jest.fn(async () => undefined);
  },
}));
jest.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: jest.fn(async () => undefined),
}));

const URL_LOCAL = 'postgres://otilc:otilc@localhost:5432/otilc';
const URL_POOLER = 'postgres://usuario:senha-ficticia@pooler.example.test:5432/postgres';
// Certificado fictício: só o formato PEM importa aqui.
const CA_PEM = `-----BEGIN CERTIFICATE-----\n${randomBytes(48).toString('base64')}\n-----END CERTIFICATE-----\n`;

describe('poolConfig', () => {
  it('fora de produção, sem DATABASE_CA_CERT, fica como antes: sem SSL', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      expect(poolConfig(URL_LOCAL, { NODE_ENV })).toEqual({ connectionString: URL_LOCAL, max: 10 });
      expect(poolConfig(URL_LOCAL, { NODE_ENV, DATABASE_CA_CERT: '' })).toEqual({
        connectionString: URL_LOCAL,
        max: 10,
      });
    }
  });

  it('em produção, usa SSL com verificação e o CA de DATABASE_CA_CERT', () => {
    expect(poolConfig(URL_POOLER, { NODE_ENV: 'production', DATABASE_CA_CERT: CA_PEM })).toEqual({
      connectionString: URL_POOLER,
      max: 10,
      ssl: { rejectUnauthorized: true, ca: CA_PEM },
    });
  });

  it('em produção, sem DATABASE_CA_CERT, recusa conectar sem imprimir valores', () => {
    for (const DATABASE_CA_CERT of [undefined, '']) {
      expect(() => poolConfig(URL_POOLER, { NODE_ENV: 'production', DATABASE_CA_CERT })).toThrow(
        /DATABASE_CA_CERT: Obrigatória em produção/,
      );
    }
    try {
      poolConfig(URL_POOLER, { NODE_ENV: 'production' });
    } catch (err) {
      expect((err as Error).message).not.toContain('senha-ficticia');
    }
  });

  it('parâmetros de SSL da URL não desligam a verificação', () => {
    const config = poolConfig(
      `${URL_POOLER}?sslmode=no-verify&ssl=false&uselibpqcompat=true&application_name=otilc`,
      { NODE_ENV: 'production', DATABASE_CA_CERT: CA_PEM },
    );
    const url = new URL(config.connectionString ?? '');
    expect([...url.searchParams.keys()]).toEqual(['application_name']);
    expect(url.password).toBe('senha-ficticia');
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: CA_PEM });
  });
});

describe('runMigrations', () => {
  beforeEach(() => {
    created.length = 0;
    jest.mocked(migrate).mockClear();
  });

  it('usa a mesma configuração de conexão da API, com SSL verificado em produção', async () => {
    const source = { NODE_ENV: 'production', DATABASE_CA_CERT: CA_PEM };
    await runMigrations(URL_POOLER, source);
    expect(created).toEqual([poolConfig(URL_POOLER, source)]);
    expect(created[0]?.ssl).toEqual({ rejectUnauthorized: true, ca: CA_PEM });
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('em produção, sem DATABASE_CA_CERT, não chega a migrar', async () => {
    await expect(runMigrations(URL_POOLER, { NODE_ENV: 'production' })).rejects.toThrow(
      /DATABASE_CA_CERT/,
    );
    expect(created).toEqual([]);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('fora de produção, migra sem SSL como hoje', async () => {
    await runMigrations(URL_LOCAL, { NODE_ENV: 'test' });
    expect(created).toEqual([{ connectionString: URL_LOCAL, max: 10 }]);
  });
});
