import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { Identity } from './identity.middleware';
import { AdminGuard } from './admin.guard';

function createContext(identity: Identity | null): ExecutionContext {
  const req = { identity } as unknown as IncomingMessage;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('rejects a null identity', () => {
    expect(() => guard.canActivate(createContext(null))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a non-admin identity', () => {
    const ctx = createContext({ login: 'user@example.com', role: 'user' });
    try {
      guard.canActivate(ctx);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        code: 'NOT_ALLOWED',
        message: 'Admin role required',
      });
    }
  });

  it('allows an identity with role=admin (as set by TailscaleAuthGuard)', () => {
    const ctx = createContext({
      login: 'admin@example.com',
      role: 'admin',
      seeded: true,
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
