import { assertLocalDatabaseUrl } from './seed';

describe('assertLocalDatabaseUrl', () => {
  it.each([
    'postgres://otilc:otilc@localhost:5432/otilc',
    'postgres://otilc:otilc@127.0.0.1:5432/otilc',
    'postgres://otilc:otilc@db:5432/otilc',
  ])('permite banco local: %s', (url) => {
    expect(() => assertLocalDatabaseUrl(url)).not.toThrow();
  });

  it('recusa banco remoto sem executar nada', () => {
    expect(() =>
      assertLocalDatabaseUrl(
        'postgres://usuario:teste-ficticio@db.producao.example.com:5432/otilc',
      ),
    ).toThrow(/não é local/i);
  });

  it('não vaza usuário nem senha na mensagem de erro', () => {
    const url = 'postgres://usuario:teste-ficticio@db.producao.example.com:5432/otilc';
    let message = '';
    try {
      assertLocalDatabaseUrl(url);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/não é local/i);
    expect(message).not.toContain('teste-ficticio');
    expect(message).not.toContain('usuario');
  });

  it('recusa URL sem host', () => {
    expect(() => assertLocalDatabaseUrl('postgres:///otilc')).toThrow(/não é local/i);
  });

  it('recusa URL malformada', () => {
    expect(() => assertLocalDatabaseUrl('isso-nao-e-uma-url')).toThrow(/inválida/i);
  });
});
