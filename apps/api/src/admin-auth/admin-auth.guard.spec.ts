import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminRole } from '@otilc/shared';
import { AdminAuthGuard, meetsRole } from './admin-auth.guard';
import type { AdminAuthService, AdminSession } from './admin-auth.service';
import { RequireAction, Roles, type AdminRequest } from './roles.decorator';
import { generateSessionToken, SESSION_COOKIE } from './session-token';

class Routes {
  @Roles('OWNER')
  ownerOnly(): void {}

  @Roles('STAFF')
  anyAdmin(): void {}

  @RequireAction('product:update')
  updateProduct(): void {}

  @RequireAction('stock:update')
  updateStock(): void {}

  open(): void {}
}

function sessionOf(role: AdminRole): AdminSession {
  return { id: 's1', user: { id: 'u1', email: 'a@b.com', name: 'A', role } };
}

function contextFor(handler: keyof Routes, cookie?: string) {
  const req: AdminRequest & { headers: Record<string, string> } = {
    headers: cookie ? { cookie } : {},
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
  } as unknown as ExecutionContext;
  return { req, context };
}

function guardWith(session: AdminSession | null) {
  const auth = { findSession: jest.fn().mockResolvedValue(session) };
  return { auth, guard: new AdminAuthGuard(auth as unknown as AdminAuthService, new Reflector()) };
}

const cookie = `${SESSION_COOKIE}=${generateSessionToken()}`;

describe('meetsRole (papel mínimo derivado de canRole)', () => {
  it.each([
    ['OWNER', 'OWNER', true],
    ['OWNER', 'STAFF', true],
    ['STAFF', 'STAFF', true],
    ['STAFF', 'OWNER', false],
  ] as const)('%s atende %s: %s', (role, required, expected) => {
    expect(meetsRole(role, required)).toBe(expected);
  });
});

describe('AdminAuthGuard', () => {
  it('401 sem cookie, sem consultar o banco', async () => {
    const { auth, guard } = guardWith(sessionOf('OWNER'));
    await expect(guard.canActivate(contextFor('open').context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(auth.findSession).not.toHaveBeenCalled();
  });

  it('401 com cookie que não corresponde a sessão válida', async () => {
    const { guard } = guardWith(null);
    await expect(guard.canActivate(contextFor('open', cookie).context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('anexa a sessão à requisição', async () => {
    const { guard } = guardWith(sessionOf('STAFF'));
    const { req, context } = contextFor('open', cookie);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.adminSession?.user.role).toBe('STAFF');
  });

  it.each([
    ['ownerOnly', 'OWNER', true],
    ['ownerOnly', 'STAFF', false],
    ['anyAdmin', 'STAFF', true],
    ['anyAdmin', 'OWNER', true],
    ['updateProduct', 'OWNER', true],
    ['updateProduct', 'STAFF', false],
    ['updateStock', 'STAFF', true],
  ] as const)('%s com %s: permitido=%s', async (handler, role, allowed) => {
    const { guard } = guardWith(sessionOf(role));
    const result = guard.canActivate(contextFor(handler, cookie).context);
    if (allowed) await expect(result).resolves.toBe(true);
    else await expect(result).rejects.toThrow(ForbiddenException);
  });
});
