import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminOriginMiddleware } from './admin-origin.middleware';
import { AdminSessionCleanupService } from './admin-session-cleanup.service';

/**
 * Login, logout e sessão do painel (ADR 0002). Módulos admin importam este módulo e usam
 * `@UseGuards(AdminAuthGuard)` com `@Roles(...)` / `@RequireAction(...)`.
 */
@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminAuthGuard, AdminSessionCleanupService],
  exports: [AdminAuthService, AdminAuthGuard],
})
export class AdminAuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Vale para toda a árvore /api/admin, inclusive os controllers da spec-005.
    consumer
      .apply(AdminOriginMiddleware)
      .forRoutes(
        { path: 'admin', method: RequestMethod.ALL },
        { path: 'admin/*path', method: RequestMethod.ALL },
      );
  }
}
