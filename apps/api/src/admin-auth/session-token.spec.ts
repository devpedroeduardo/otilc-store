import {
  generateSessionToken,
  hashSessionToken,
  readSessionToken,
  SESSION_COOKIE,
} from './session-token';

describe('token de sessão', () => {
  it('tem 32 bytes aleatórios em base64url', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(token);
  });

  it('o hash é SHA-256 em hex e não contém o token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toContain(token);
  });

  it('lê o cookie da sessão entre outros cookies', () => {
    const token = generateSessionToken();
    expect(readSessionToken(`a=1; ${SESSION_COOKIE}=${token}; b=2`)).toBe(token);
  });

  it.each([
    undefined,
    ['lista'],
    '',
    'outro=valor',
    `${SESSION_COOKIE}=`,
    `${SESSION_COOKIE}=curto`,
    `${SESSION_COOKIE}=${'a'.repeat(42)}%27`,
    `${SESSION_COOKIE}=${'a'.repeat(44)}`,
  ])('cookie ausente ou fora do formato vira null: %p', (header) => {
    expect(readSessionToken(header)).toBeNull();
  });
});
