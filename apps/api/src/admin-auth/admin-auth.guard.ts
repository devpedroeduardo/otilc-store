import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { adminActions, canRole, type AdminAction, type AdminRole } from '@otilc/shared';
import type { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { ACTION_KEY, ROLES_KEY, type AdminRequest } from './roles.decorator';
import { readSessionToken } from './session-token';

/**
 * `required` é "papel mínimo": `role` passa se puder fazer tudo que `required` pode.
 * Derivado de `canRole`, então OWNER cobre STAFF sem uma hierarquia escrita à mão.
 */
export function meetsRole(role: AdminRole, required: AdminRole): boolean {
  return adminActions.every((action) => !canRole(required, action) || canRole(role, action));
}

/**
 * Exige sessão de admin válida (401) e, se a rota pedir, papel mínimo (`@Roles`) e ação
 * (`@RequireAction`), decididos por `canRole` (403). Uso: `@UseGuards(AdminAuthGuard)`.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & AdminRequest>();
    const token = readSessionToken(req.headers.cookie);
    const session = token ? await this.auth.findSession(token) : null;
    if (!session) throw new UnauthorizedException('Sessão inválida ou expirada.');

    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, targets);
    const action = this.reflector.getAllAndOverride<AdminAction | undefined>(ACTION_KEY, targets);
    const { role } = session.user;
    if (roles?.length && !roles.some((required) => meetsRole(role, required))) {
      throw new ForbiddenException('Sem permissão para esta ação.');
    }
    if (action && !canRole(role, action)) {
      throw new ForbiddenException('Sem permissão para esta ação.');
    }

    req.adminSession = session;
    return true;
  }
}
