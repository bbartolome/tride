import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { WebuiConfigModule } from './config/webui-config.module';
import { WebuiConfigService } from './config/webui-config.service';
import { AuthModule } from './auth/auth.module';
import { GitModule } from './git/git.module';
import { HealthController } from './health/health.controller';
import { TerminalModule } from './terminal/terminal.module';
import { WorkspaceModule } from './workspace/workspace.module';

@Module({
  imports: [
    WebuiConfigModule,
    AuthModule,
    WorkspaceModule,
    GitModule,
    TerminalModule,
    // Serves the built Angular SPA and falls back to index.html for any
    // unmatched GET route (client-side routing). `exclude` uses the
    // path-to-regexp v8 wildcard syntax Nest 12 requires (F18) — a bare '*'
    // throws "Missing parameter name" at boot under Express 5.
    //
    // `renderPath` is deliberately left at the package default rather than
    // set to '*' as an earlier draft of this plan suggested: the default is
    // already '{*any}', which is path-to-regexp v8 correct, and passing the
    // literal string '*' throws that same "Missing parameter name" error at
    // boot under Express 5 — empirically confirmed while wiring this up
    // (see T20 verification notes).
    ServeStaticModule.forRootAsync({
      useFactory: (configService: WebuiConfigService) => [
        {
          rootPath:
            configService.config.staticRoot ??
            join(__dirname, '..', '..', 'web', 'browser'),
          exclude: ['/api/{*path}', '/healthz', '/ws/{*path}'],
          serveStaticOptions: { index: false, redirect: false },
        },
      ],
      inject: [WebuiConfigService],
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
