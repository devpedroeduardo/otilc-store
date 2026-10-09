import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth';
import { AdminCatalogController } from './admin-catalog.controller';
import { AdminCatalogService } from './admin-catalog.service';

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminCatalogController],
  providers: [AdminCatalogService],
})
export class AdminCatalogModule {}
