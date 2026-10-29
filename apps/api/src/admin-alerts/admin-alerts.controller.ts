import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  adminAlertQuerySchema,
  type AdminAlertDto,
  type AdminAlertQuery,
  type Paginated,
} from '@otilc/shared';
import { AdminAuthGuard, CurrentSession, RequireAction, type AdminSession } from '../admin-auth';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminAlertsService } from './admin-alerts.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * Alertas de pagamento do painel (spec-018, docs/api/admin.md). Mesmas ações dos pedidos:
 * ver exige `order:read`; resolver e retomar, `order:updateStatus` (OWNER e STAFF).
 */
@UseGuards(AdminAuthGuard)
@Controller('admin/alerts')
export class AdminAlertsController {
  constructor(@Inject(AdminAlertsService) private readonly alerts: AdminAlertsService) {}

  @RequireAction('order:read')
  @Get()
  list(
    @Query(new ZodValidationPipe(adminAlertQuerySchema)) query: AdminAlertQuery,
  ): Promise<Paginated<AdminAlertDto>> {
    return this.alerts.list(query);
  }

  @RequireAction('order:updateStatus')
  @Post(':id/resolve')
  @HttpCode(200)
  resolve(
    @Param('id', uuid) id: string,
    @CurrentSession() session: AdminSession,
  ): Promise<AdminAlertDto> {
    return this.alerts.resolve(id, session.user.id);
  }

  @RequireAction('order:updateStatus')
  @Post(':id/resume-reconciliation')
  @HttpCode(200)
  resumeReconciliation(
    @Param('id', uuid) id: string,
    @CurrentSession() session: AdminSession,
  ): Promise<AdminAlertDto> {
    return this.alerts.resumeReconciliation(id, session.user.id);
  }
}
