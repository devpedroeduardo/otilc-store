import { hashPassword, verifyPassword } from './password';

describe('hash de senha (scrypt)', () => {
  it('confere a senha certa e recusa a errada', async () => {
    const hash = await hashPassword('uma-senha-bem-longa');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain('uma-senha-bem-longa');
    await expect(verifyPassword('uma-senha-bem-longa', hash)).resolves.toBe(true);
    await expect(verifyPassword('uma-senha-bem-longA', hash)).resolves.toBe(false);
  });

  it('usa um sal diferente por hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('mesma-senha-123'),
      hashPassword('mesma-senha-123'),
    ]);
    expect(a).not.toBe(b);
  });

  it.each([
    '',
    'texto-qualquer',
    'bcrypt$10$abc$def',
    'scrypt$16384$8$1$$',
    'scrypt$1000$8$1$c2FsdA==$aGFzaA==', // N não é potência de 2
    'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==', // N absurdo
    'scrypt$16384$8$1$c2FsdA==$aGFzaA==$extra',
  ])('hash malformado nunca confere: %p', async (stored) => {
    await expect(verifyPassword('qualquer-senha-longa', stored)).resolves.toBe(false);
  });
});
