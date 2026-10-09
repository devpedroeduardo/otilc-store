import { hashPassword, verifyPassword } from './password';

describe('hash de senha (scrypt)', () => {
  it('confere a senha certa e recusa a errada', async () => {
    const hash = await hashPassword('teste-nao-e-uma-senha-real');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain('teste-nao-e-uma-senha-real');
    await expect(verifyPassword('teste-nao-e-uma-senha-real', hash)).resolves.toBe(true);
    await expect(verifyPassword('teste-nao-e-uma-senha-reaL', hash)).resolves.toBe(false);
  });

  it('usa um sal diferente por hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('teste-mesma-senha-123'),
      hashPassword('teste-mesma-senha-123'),
    ]);
    expect(a).not.toBe(b);
  });

  it.each([
    '',
    'teste-texto-qualquer',
    'bcrypt$10$abc$def',
    'scrypt$16384$8$1$$',
    'scrypt$1000$8$1$c2FsdA==$aGFzaA==', // N não é potência de 2
    'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==', // N absurdo
    'scrypt$16384$8$1$c2FsdA==$aGFzaA==$extra',
  ])('hash malformado nunca confere: %p', async (stored) => {
    await expect(verifyPassword('teste-qualquer-senha-longa', stored)).resolves.toBe(false);
  });
});
