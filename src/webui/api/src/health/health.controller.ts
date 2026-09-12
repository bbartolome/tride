import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
