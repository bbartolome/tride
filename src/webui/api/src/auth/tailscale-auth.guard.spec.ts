import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'http';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import type { Identity } from './identity.middleware';
import { TailscaleAuthGuard } from './tailscale-auth.guard';
import type { UsersService } from './users.service';

function createUsersService(
  allowed: { role: 'admin' | 'user'; seeded: boolean } | null,
): UsersService {
  return {
    isAllowed: jest.fn().mockResolvedValue(allowed),
  } as unknown as UsersService;
}

function createContext(
  identity: Identity | null,
  isPublic: boolean,
): ExecutionContext {
  const req = { identity } as unknown as IncomingMessage;
  const handler = function handler() {};
  const klass = class Controller {};
  if (isPublic) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;
}

describe('TailscaleAuthGuard', () => {
  it('lets a null identity through on a @Public route', async () => {
    const guard = new TailscaleAuthGuard(
      new Reflector(),
      createUsersService(null),
    );
    const ctx = createContext(null, true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws 401 AUTH_REQUIRED when identity is null on a non-public route', async () => {
    const guard = new TailscaleAuthGuard(
      new Reflector(),
      createUsersService(null),
    );
    const ctx = createContext(null, false);
    try {
      await guard.canActivate(ctx);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getResponse()).toEqual({
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
      });
    }
  });

  it('throws 403 NOT_ALLOWED with the rejected login in detail when UsersService.isAllowed returns null', async () => {
    const guard = new TailscaleAuthGuard(
      new Reflector(),
      createUsersService(null),
    );
    const ctx = createContext({ login: 'nobody@example.com' }, false);
    try {
      await guard.canActivate(ctx);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        code: 'NOT_ALLOWED',
        message: 'Not allowed',
        detail: { login: 'nobody@example.com' },
      });
    }
  });

  it('reports the exact rejected login in detail.login, not a generic placeholder', async () => {
    const guard = new TailscaleAuthGuard(
      new Reflector(),
      createUsersService(null),
    );
    const ctx = createContext({ login: 'someone-else@github' }, false);
    try {
      await guard.canActivate(ctx);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const response = (err as ForbiddenException).getResponse() as {
        detail?: { login?: string };
      };
      expect(response.detail).toEqual({ login: 'someone-else@github' });
    }
  });

  it('allows an allowed login and copies role/seeded from UsersService.isAllowed', async () => {
    const guard = new TailscaleAuthGuard(
      new Reflector(),
      createUsersService({ role: 'admin', seeded: true }),
    );
    const identity: Identity = { login: 'admin@example.com' };
    const ctx = createContext(identity, false);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(identity.role).toBe('admin');
    expect(identity.seeded).toBe(true);
  });
});
