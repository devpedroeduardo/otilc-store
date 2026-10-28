import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service';
import { OrdersService } from './orders.service';

/**
 * A cada minuto, devolve ao estoque as unidades de pedidos não pagos dentro do prazo e, depois do
 * commit, cancela no Mercado Pago o Pix pendente deles (spec-015).
 */
@Injectable()
export class OrderExpirationService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OrderExpirationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PaymentReconciliationService) private readonly payments: PaymentReconciliationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.run().catch((err) => this.logger.error(err));
    }, 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Uma rodada. O cancelamento só começa depois de a expiração estar commitada. */
  async run(now = new Date()): Promise<void> {
    const expired = await this.orders.expireDue(now);
    await this.payments.cancelForExpiredOrders(expired);
  }
}
