import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { checkoutSchema, type CheckoutInput, type OrderDto } from '@otilc/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /** Limite mais baixo que o resto da API: criar pedido reserva estoque. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  create(@Body(new ZodValidationPipe(checkoutSchema)) input: CheckoutInput): Promise<OrderDto> {
    return this.orders.create(input);
  }

  /** O id é um UUID aleatório: só quem criou o pedido conhece o endereço. */
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<OrderDto> {
    return this.orders.findById(id);
  }
}
