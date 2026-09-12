import { Module } from '@nestjs/common';
import { WebuiConfigModule } from './config/webui-config.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [WebuiConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
