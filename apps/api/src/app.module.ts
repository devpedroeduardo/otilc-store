import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CatalogModule } from './catalog/catalog.module';
import { ENV, type Env } from './config/env';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { OrdersModule } from './orders/orders.module';

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        {
          module: class EnvModule {},
          global: true,
          providers: [{ provide: ENV, useValue: env }],
          exports: [ENV],
        },
        // Limite geral por IP: 120 requisições por minuto.
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
        DatabaseModule,
        CatalogModule,
        OrdersModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    };
  }
}
