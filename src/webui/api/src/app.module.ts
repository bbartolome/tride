import { Module } from '@nestjs/common';
import { WebuiConfigModule } from './config/webui-config.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [WebuiConfigModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
