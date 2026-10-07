import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { OrdersService } from './orders.service';

/** A cada minuto, devolve ao estoque as unidades de pedidos não pagos dentro do prazo. */
@Injectable()
export class OrderExpirationService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OrderExpirationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.orders.releaseExpired().catch((err) => this.logger.error(err));
    }, 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
