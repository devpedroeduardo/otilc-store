import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const SESSION_COOKIE = 'otilc_admin';
/** `Path=/`: o cookie vai para as páginas `/admin/**` da loja e para `/api/admin/**` (spec-007). */
export const SESSION_COOKIE_PATH = '/';
/** Validade da sessão e do cookie (ADR 0002 e docs/api/admin.md: `Max-Age=28800`). */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** 32 bytes em base64url: 43 caracteres sem preenchimento. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Token aleatório de 32 bytes. Só existe no cookie; o banco guarda o hash. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 em hex (64 caracteres), o que vai para `admin_sessions.token_hash`. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Lê e valida o token do header `Cookie`. Qualquer coisa fora do formato vira `null`. */
export function readSessionToken(cookieHeader: unknown): string | null {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const parsed = tokenSchema.safeParse(part.slice(eq + 1).trim());
    return parsed.success ? parsed.data : null;
  }
  return null;
}
