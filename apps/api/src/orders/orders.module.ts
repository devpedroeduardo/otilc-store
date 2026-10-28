import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { OrderExpirationService } from './order-expiration.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderExpirationService],
  exports: [OrdersService],
})
export class OrdersModule {}
