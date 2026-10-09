import { newAdminSchema } from './new-admin';

const valid = {
  email: '  Dono@Example.test ',
  name: ' Dono ',
  role: 'owner',
  password: 'teste-nao-e-uma-senha-real',
};

describe('newAdminSchema (script admin:create)', () => {
  it('normaliza e-mail, nome e papel', () => {
    expect(newAdminSchema.parse(valid)).toEqual({
      email: 'dono@example.test',
      name: 'Dono',
      role: 'OWNER',
      password: 'teste-nao-e-uma-senha-real',
    });
  });

  it('recusa senha com menos de 12 caracteres', () => {
    const result = newAdminSchema.safeParse({ ...valid, password: 'curta-11chr' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['password']);
  });

  it.each([{ email: 'nao-e-email' }, { name: '  ' }, { role: 'ADMIN' }])('recusa %p', (patch) => {
    expect(newAdminSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
