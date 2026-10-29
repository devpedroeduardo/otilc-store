import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminAlertsController],
  providers: [AdminAlertsService],
})
export class AdminAlertsModule {}
