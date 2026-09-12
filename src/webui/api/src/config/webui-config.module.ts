import { Global, Module } from '@nestjs/common';
import { WebuiConfigService } from './webui-config.service';

@Global()
@Module({
  providers: [WebuiConfigService],
  exports: [WebuiConfigService],
})
export class WebuiConfigModule {}
