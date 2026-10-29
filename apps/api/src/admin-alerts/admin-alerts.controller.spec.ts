import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { canRole, type AdminAction } from '@otilc/shared';
import { AdminAuthGuard } from '../admin-auth';
import { ACTION_KEY } from '../admin-auth/roles.decorator';
import { AdminAlertsController } from './admin-alerts.controller';

const reflector = new Reflector();
const actionOf = (handler: keyof AdminAlertsController) =>
  reflector.get<AdminAction | undefined>(ACTION_KEY, AdminAlertsController.prototype[handler]);

describe('AdminAlertsController: permissões', () => {
  it('a classe inteira passa pelo AdminAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAlertsController)).toEqual([AdminAuthGuard]);
  });

  it('ler exige order:read; resolver e retomar exigem order:updateStatus, como mudar status de pedido', () => {
    expect(actionOf('list')).toBe('order:read');
    expect(actionOf('resolve')).toBe('order:updateStatus');
    expect(actionOf('resumeReconciliation')).toBe('order:updateStatus');
  });

  it('OWNER e STAFF podem as 3 rotas (o 403 de papel é do guard, testado em admin-auth.guard.spec)', () => {
    for (const handler of ['list', 'resolve', 'resumeReconciliation'] as const) {
      for (const role of ['OWNER', 'STAFF'] as const) {
        expect(canRole(role, actionOf(handler)!)).toBe(true);
      }
    }
  });
});
