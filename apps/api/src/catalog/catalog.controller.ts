import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  catalogQuerySchema,
  type CatalogQuery,
  type CategoryDto,
  type Paginated,
  type ProductDetailDto,
  type ProductListItemDto,
} from '@otilc/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CatalogService } from './catalog.service';

const slugSchema = z.string().regex(/^[a-z0-9-]{1,120}$/, 'Endereço de produto inválido.');

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('categories')
  categories(): Promise<CategoryDto[]> {
    return this.catalog.listCategories();
  }

  @Get('products')
  list(
    @Query(new ZodValidationPipe(catalogQuerySchema)) query: CatalogQuery,
  ): Promise<Paginated<ProductListItemDto>> {
    return this.catalog.list(query);
  }

  @Get('products/:slug')
  detail(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
  ): Promise<ProductDetailDto> {
    return this.catalog.findBySlug(slug);
  }
}
