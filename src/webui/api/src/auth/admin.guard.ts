import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { ERROR_CODES } from '../common/error-codes';

/**
 * Method-scoped only — see T1 finding F10: this must never be registered as
 * an APP_GUARD. It is applied via @UseGuards() on the individual
 * user-management mutations (T4), always downstream of the global
 * SameOriginGuard + TailscaleAuthGuard pair, which run first and populate
 * `req.identity`.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<IncomingMessage>();

    // TailscaleAuthGuard already set role='admin' inline for a seeded login
    // (WebuiConfigService.config.adminLogins) before this guard ever runs.
    // T4 replaces that inline seeded-check with `usersService.isAllowed`,
    // which will populate the same `role` field from the runtime allowlist
    // too — this guard itself does not need to change.
    if (req.identity?.role !== 'admin') {
      throw new ForbiddenException({
        code: ERROR_CODES.NOT_ALLOWED,
        message: 'Admin role required',
      });
    }

    return true;
  }
}
