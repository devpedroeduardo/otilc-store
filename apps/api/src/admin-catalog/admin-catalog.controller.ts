import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  adminProductInputSchema,
  adminProductPatchSchema,
  adminStockUpdateSchema,
  adminVariantInputSchema,
  type AdminProductDto,
  type AdminProductInput,
  type AdminProductPatch,
  type AdminStockUpdate,
  type AdminVariantDto,
  type AdminVariantInput,
} from '@otilc/shared';
import { AdminAuthGuard, RequireAction } from '../admin-auth';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminCatalogService } from './admin-catalog.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/** Produtos, variações e estoque do painel (docs/api/admin.md). */
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminCatalogController {
  constructor(@Inject(AdminCatalogService) private readonly catalog: AdminCatalogService) {}

  @RequireAction('product:read')
  @Get('products')
  list(): Promise<AdminProductDto[]> {
    return this.catalog.list();
  }

  @RequireAction('product:read')
  @Get('products/:id')
  findOne(@Param('id', uuid) id: string): Promise<AdminProductDto> {
    return this.catalog.findById(id);
  }

  @RequireAction('product:create')
  @Post('products')
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(adminProductInputSchema)) input: AdminProductInput,
  ): Promise<AdminProductDto> {
    return this.catalog.create(input);
  }

  @RequireAction('product:update')
  @Patch('products/:id')
  update(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(adminProductPatchSchema)) patch: AdminProductPatch,
  ): Promise<AdminProductDto> {
    return this.catalog.update(id, patch);
  }

  @RequireAction('variant:create')
  @Post('products/:id/variants')
  @HttpCode(201)
  createVariant(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(adminVariantInputSchema)) input: AdminVariantInput,
  ): Promise<AdminVariantDto> {
    return this.catalog.createVariant(id, input);
  }

  @RequireAction('stock:update')
  @Put('variants/:id/stock')
  updateStock(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(adminStockUpdateSchema)) input: AdminStockUpdate,
  ): Promise<AdminVariantDto> {
    return this.catalog.updateStock(id, input.stock);
  }
}
