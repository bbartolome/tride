import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { Identity } from '../identity.middleware';

/**
 * Injects the caller's identity (as set by IdentityMiddleware and
 * TailscaleAuthGuard) into a controller method parameter. Null only when
 * used on a @Public() route the guards let through with no identity.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Identity | null => {
    const req = ctx.switchToHttp().getRequest<IncomingMessage>();
    return req.identity ?? null;
  },
);
