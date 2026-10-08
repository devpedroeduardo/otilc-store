import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AdminAuthService } from './admin-auth.service';

/** A cada 10 minutos, apaga do banco as sessões de admin que já venceram. */
@Injectable()
export class AdminSessionCleanupService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AdminSessionCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.auth.deleteExpiredSessions().catch((err) => this.logger.error(err));
    }, 10 * 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
