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

    // TailscaleAuthGuard already ran earlier in this same request and set
    // req.identity.role/seeded from UsersService.isAllowed(identity.login)
    // (the runtime allowlist layered on top of the WEBUI_ADMIN_LOGINS seeded
    // set). This guard is deliberately just a role check — it does not call
    // UsersService itself, keeping it a cheap, synchronous, method-scoped
    // gate on top of that already-computed role.
    if (req.identity?.role !== 'admin') {
      throw new ForbiddenException({
        code: ERROR_CODES.NOT_ALLOWED,
        message: 'Admin role required',
      });
    }

    return true;
  }
}
