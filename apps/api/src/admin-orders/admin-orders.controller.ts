import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  adminOrderQuerySchema,
  adminOrderStatusUpdateSchema,
  type AdminOrderDetailDto,
  type AdminOrderListItemDto,
  type AdminOrderQuery,
  type AdminOrderStatusUpdate,
  type Paginated,
} from '@otilc/shared';
import { AdminAuthGuard, RequireAction } from '../admin-auth';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOrdersService } from './admin-orders.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/** Pedidos do painel (docs/api/admin.md). */
@UseGuards(AdminAuthGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(@Inject(AdminOrdersService) private readonly orders: AdminOrdersService) {}

  @RequireAction('order:read')
  @Get()
  list(
    @Query(new ZodValidationPipe(adminOrderQuerySchema)) query: AdminOrderQuery,
  ): Promise<Paginated<AdminOrderListItemDto>> {
    return this.orders.list(query);
  }

  @RequireAction('order:read')
  @Get(':id')
  findOne(@Param('id', uuid) id: string): Promise<AdminOrderDetailDto> {
    return this.orders.findById(id);
  }

  @RequireAction('order:updateStatus')
  @Patch(':id/status')
  updateStatus(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(adminOrderStatusUpdateSchema)) input: AdminOrderStatusUpdate,
  ): Promise<AdminOrderDetailDto> {
    return this.orders.updateStatus(id, input.status);
  }
}
