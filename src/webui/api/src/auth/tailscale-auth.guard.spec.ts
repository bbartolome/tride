import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'http';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import type { WebuiConfigService } from '../config/webui-config.service';
import type { Identity } from './identity.middleware';
import { TailscaleAuthGuard } from './tailscale-auth.guard';

function createConfig(adminLogins: string[]): WebuiConfigService {
  return {
    config: {
      port: 8088,
      workspaceRoot: '/root/workspace',
      adminLogins: new Set(adminLogins),
      stateDir: '/var/lib/devcontainer-webui',
      tmuxSocket: 'webui',
    },
  } as unknown as WebuiConfigService;
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
  it('lets a null identity through on a @Public route', () => {
    const guard = new TailscaleAuthGuard(new Reflector(), createConfig([]));
    const ctx = createContext(null, true);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws 401 AUTH_REQUIRED when identity is null on a non-public route', () => {
    const guard = new TailscaleAuthGuard(new Reflector(), createConfig([]));
    const ctx = createContext(null, false);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    try {
      guard.canActivate(ctx);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getResponse()).toEqual({
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
      });
    }
  });

  it('throws 403 NOT_ALLOWED for a non-seeded login', () => {
    const guard = new TailscaleAuthGuard(
      new Reflector(),
      createConfig(['admin@example.com']),
    );
    const ctx = createContext({ login: 'nobody@example.com' }, false);
    try {
      guard.canActivate(ctx);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        code: 'NOT_ALLOWED',
        message: 'Not allowed',
      });
    }
  });

  it('allows a seeded login and marks it role=admin, seeded=true', () => {
    const guard = new TailscaleAuthGuard(
      new Reflector(),
      createConfig(['admin@example.com']),
    );
    const identity: Identity = { login: 'admin@example.com' };
    const ctx = createContext(identity, false);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(identity.role).toBe('admin');
    expect(identity.seeded).toBe(true);
  });
});
