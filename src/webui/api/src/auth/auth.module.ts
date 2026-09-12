import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminGuard } from './admin.guard';
import { IdentityMiddleware } from './identity.middleware';
import { SameOriginGuard } from './same-origin.guard';
import { TailscaleAuthGuard } from './tailscale-auth.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [
    // Binding order matters: Nest runs global guards in registration order,
    // and the CSRF check must run before the auth check.
    { provide: APP_GUARD, useClass: SameOriginGuard },
    { provide: APP_GUARD, useClass: TailscaleAuthGuard },
    AdminGuard,
    UsersService,
  ],
  exports: [AdminGuard, UsersService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // path-to-regexp v8 (Nest 12) rejects a bare '*' wildcard; '{*path}'
    // is the v8-compatible "match everything" route.
    consumer.apply(IdentityMiddleware).forRoutes('{*path}');
  }
}
