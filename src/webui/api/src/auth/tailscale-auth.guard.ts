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

@Injectable()
export class TailscaleAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly webuiConfig: WebuiConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<IncomingMessage>();
    const identity = req.identity ?? null;

    if (identity === null) {
      throw new UnauthorizedException({
        code: ERROR_CODES.AUTH_REQUIRED,
        message: 'Authentication required',
      });
    }

    // T4 replaces this inline membership check with
    // `usersService.isAllowed(login)`, which layers the runtime allowlist
    // (${WEBUI_STATE_DIR}/users.json) on top of the seeded admins below.
    // UsersService does not exist yet (T4's deliverable), so for now this
    // guard only knows about the boot-time seeded admin set.
    if (this.webuiConfig.config.adminLogins.has(identity.login)) {
      identity.role = 'admin';
      identity.seeded = true;
      return true;
    }

    throw new ForbiddenException({
      code: ERROR_CODES.NOT_ALLOWED,
      message: 'Not allowed',
    });
  }
}
