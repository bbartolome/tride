import { Module } from '@nestjs/common';
import { WebuiConfigModule } from './config/webui-config.module';
import { AuthModule } from './auth/auth.module';
import { GitModule } from './git/git.module';
import { HealthController } from './health/health.controller';
import { WorkspaceModule } from './workspace/workspace.module';

@Module({
  imports: [WebuiConfigModule, AuthModule, WorkspaceModule, GitModule],
  controllers: [HealthController],
})
export class AppModule {}
