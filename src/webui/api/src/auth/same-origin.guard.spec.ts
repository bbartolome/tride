import type { ExecutionContext } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { isSameOriginRequest, SameOriginGuard } from './same-origin.guard';

function createContext(
  headers: Record<string, string | string[] | undefined>,
  method: string,
): ExecutionContext {
  const req = { headers, method } as unknown as IncomingMessage;
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('isSameOriginRequest (pure function)', () => {
  const expectedOrigin = 'http://tride:8088';

  it('allows GET with none of the CSRF headers present', () => {
    expect(isSameOriginRequest({}, 'GET', expectedOrigin)).toBe(true);
  });

  it('allows HEAD with none of the CSRF headers present', () => {
    expect(isSameOriginRequest({}, 'HEAD', expectedOrigin)).toBe(true);
  });

  it('rejects a POST missing X-Webui-Request', () => {
    expect(
      isSameOriginRequest({ origin: expectedOrigin }, 'POST', expectedOrigin),
    ).toBe(false);
  });

  it('rejects a POST with a foreign Origin', () => {
    expect(
      isSameOriginRequest(
        { 'x-webui-request': '1', origin: 'http://evil.com' },
        'POST',
        expectedOrigin,
      ),
    ).toBe(false);
  });

  it('rejects a POST with Sec-Fetch-Site: cross-site', () => {
    expect(
      isSameOriginRequest(
        { 'x-webui-request': '1', 'sec-fetch-site': 'cross-site' },
        'POST',
        expectedOrigin,
      ),
    ).toBe(false);
  });

  it('allows a POST with the correct triple', () => {
    expect(
      isSameOriginRequest(
        {
          'x-webui-request': '1',
          origin: expectedOrigin,
          'sec-fetch-site': 'same-origin',
        },
        'POST',
        expectedOrigin,
      ),
    ).toBe(true);
  });

  it('allows a POST with Sec-Fetch-Site: none', () => {
    expect(
      isSameOriginRequest(
        { 'x-webui-request': '1', 'sec-fetch-site': 'none' },
        'POST',
        expectedOrigin,
      ),
    ).toBe(true);
  });

  it('allows a POST with X-Webui-Request only and no Origin/Sec-Fetch-Site headers', () => {
    expect(
      isSameOriginRequest({ 'x-webui-request': '1' }, 'POST', expectedOrigin),
    ).toBe(true);
  });
});

describe('SameOriginGuard', () => {
  const guard = new SameOriginGuard();

  it('allows a GET with no CSRF headers', () => {
    const ctx = createContext({ host: 'tride:8088' }, 'GET');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a POST without X-Webui-Request', () => {
    const ctx = createContext({ host: 'tride:8088' }, 'POST');
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('rejects a POST with a foreign Origin even with X-Webui-Request set', () => {
    const ctx = createContext(
      {
        host: 'tride:8088',
        'x-webui-request': '1',
        origin: 'http://evil.com',
      },
      'POST',
    );
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('allows a POST with the correct triple against the request Host', () => {
    const ctx = createContext(
      {
        host: 'tride:8088',
        'x-webui-request': '1',
        origin: 'http://tride:8088',
        'sec-fetch-site': 'same-origin',
      },
      'POST',
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
