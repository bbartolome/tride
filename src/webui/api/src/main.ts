import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { WebuiConfigService } from './config/webui-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('bootstrap');

  app.useGlobalFilters(new AppExceptionFilter());

  // Deliberately no app.enableCors() and no CORS package: emitting no
  // Access-Control-Allow-* headers is load-bearing for the CSRF defence
  // (same-origin guard relies on the absence of CORS to keep cross-origin
  // browsers from ever completing a request). Do not "fix" this later.

  const configService = app.get(WebuiConfigService);
  const { port } = configService.config;

  // Hardcoded loopback bind — never make this configurable, even though
  // WEBUI_HOST exists in the env file. Exposure beyond loopback is handled
  // by `tailscale serve`, not by this process.
  await app.listen(port, '127.0.0.1');
  logger.log(`webui api listening on http://127.0.0.1:${port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
