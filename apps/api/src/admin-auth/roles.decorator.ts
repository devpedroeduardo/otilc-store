import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { AdminAction, AdminRole } from '@otilc/shared';
import type { AdminSession } from './admin-auth.service';

export const ROLES_KEY = 'otilc:admin-roles';
export const ACTION_KEY = 'otilc:admin-action';

/**
 * Papel mínimo da rota (docs/api/admin.md): `@Roles('OWNER')` só deixa o dono passar;
 * `@Roles('STAFF')` ou nenhum decorator deixa qualquer admin logado.
 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/** Ação que a rota exige; o `AdminAuthGuard` decide com `canRole(papel, ação)`. */
export const RequireAction = (action: AdminAction) => SetMetadata(ACTION_KEY, action);

/** Requisição que já passou pelo `AdminAuthGuard`. */
export interface AdminRequest {
  adminSession?: AdminSession;
}

/** Sessão da requisição, preenchida pelo `AdminAuthGuard`. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminSession => {
    const session = ctx.switchToHttp().getRequest<AdminRequest>().adminSession;
    if (!session) throw new Error('CurrentSession usado em rota sem AdminAuthGuard.');
    return session;
  },
);
