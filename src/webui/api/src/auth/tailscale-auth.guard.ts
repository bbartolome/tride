import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'http';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ERROR_CODES } from '../common/error-codes';
import { WebuiConfigService } from '../config/webui-config.service';
import { UsersService } from './users.service';

@Injectable()
export class TailscaleAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
    private readonly webuiConfig: WebuiConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<IncomingMessage>();

    if (!this.webuiConfig.config.requireAuth) {
      // Auth disabled (the default): don't enforce the identity/allowlist
      // check, but still seed req.identity as a full admin so AdminGuard
      // and UsersController.me() - both of which assume this guard already
      // ran and populated role/seeded - don't fail closed.
      req.identity ??= { login: 'anonymous' };
      req.identity.role = 'admin';
      req.identity.seeded = true;
      return true;
    }

    const identity = req.identity ?? null;

    if (identity === null) {
      throw new UnauthorizedException({
        code: ERROR_CODES.AUTH_REQUIRED,
        message: 'Authentication required',
      });
    }

    const allowed = await this.usersService.isAllowed(identity.login);
    if (allowed === null) {
      throw new ForbiddenException({
        code: ERROR_CODES.NOT_ALLOWED,
        message: 'Not allowed',
        detail: { login: identity.login },
      });
    }

    identity.role = allowed.role;
    identity.seeded = allowed.seeded;
    return true;
  }
}
