import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hash de senha com scrypt (node:crypto) e sal aleatório por usuário (ADR 0002).
 * Formato gravado em `admin_users.password_hash`: `scrypt$N$r$p$<sal base64>$<hash base64>`.
 * Os parâmetros ficam no próprio hash para poderem subir no futuro sem invalidar senhas antigas.
 */
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// Limites para não aceitar parâmetros absurdos de um hash malformado.
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function scryptOptions(N: number, r: number, p: number): ScryptOptions {
  // O scrypt usa ~128 * N * r bytes de memória; o padrão do Node (32 MiB) pode ser pouco.
  return { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = PARAMS;
  const key = await deriveKey(password, salt, KEY_LENGTH, scryptOptions(N, r, p));
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Confere a senha com `timingSafeEqual`. Hash malformado nunca confere (e não lança). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map((n) => (/^\d+$/.test(n) ? Number(n) : NaN));
  const valid =
    Number.isSafeInteger(N) &&
    N > 1 &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= MAX_R &&
    p >= 1 &&
    p <= MAX_P;
  if (!valid) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await deriveKey(password, salt, expected.length, scryptOptions(N, r, p));
  return timingSafeEqual(actual, expected);
}
