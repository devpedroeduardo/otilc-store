import { Module } from '@nestjs/common';
import { OrderExpirationService } from './order-expiration.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrderExpirationService],
  exports: [OrdersService],
})
export class OrdersModule {}
