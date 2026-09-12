import type { IncomingMessage, ServerResponse } from 'http';
import {
  IdentityMiddleware,
  normalizeDisplayValue,
  normalizeLogin,
} from './identity.middleware';

function createRequest(
  headers: Record<string, string | string[] | undefined>,
): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('normalizeLogin', () => {
  it('returns null when the header is missing', () => {
    expect(normalizeLogin(undefined)).toBeNull();
  });

  it('returns null for an empty/whitespace-only value', () => {
    expect(normalizeLogin('')).toBeNull();
    expect(normalizeLogin('   ')).toBeNull();
  });

  it('rejects a value containing a comma (duplicate-header shape)', () => {
    expect(normalizeLogin('me@example.com, attacker@evil.com')).toBeNull();
  });

  it('rejects an array header value (Node splits duplicates into an array here) by joining with a comma and rejecting', () => {
    expect(normalizeLogin(['me@example.com', 'attacker@evil.com'])).toBeNull();
  });

  it('rejects internal whitespace', () => {
    expect(normalizeLogin('me @example.com')).toBeNull();
  });

  it('rejects control characters embedded in the value', () => {
    expect(normalizeLogin('me@exa\x07mple.com')).toBeNull();
    expect(normalizeLogin('me@example\t.com')).toBeNull();
  });

  it('caps at 254 characters', () => {
    const long = `${'a'.repeat(300)}@example.com`;
    const result = normalizeLogin(long);
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(254);
  });

  it('trims and lowercases a valid login', () => {
    expect(normalizeLogin('  Me@Example.com  ')).toBe('me@example.com');
  });
});

describe('normalizeDisplayValue', () => {
  it('returns undefined when missing or empty', () => {
    expect(normalizeDisplayValue(undefined)).toBeUndefined();
    expect(normalizeDisplayValue('   ')).toBeUndefined();
  });

  it('trims and caps but never rejects odd content', () => {
    expect(normalizeDisplayValue('  Jane, Doe  ')).toBe('Jane, Doe');
    const long = 'x'.repeat(300);
    expect(normalizeDisplayValue(long)?.length).toBeLessThanOrEqual(254);
  });
});

describe('IdentityMiddleware', () => {
  const middleware = new IdentityMiddleware();

  function run(
    headers: Record<string, string | string[] | undefined>,
  ): IncomingMessage {
    const req = createRequest(headers);
    const next = jest.fn();
    middleware.use(req, {} as ServerResponse, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req;
  }

  it('sets identity to null when the header is missing', () => {
    const req = run({});
    expect(req.identity).toBeNull();
  });

  it('sets identity to null when the login header contains a comma', () => {
    const req = run({ 'tailscale-user-login': 'me@example.com, x@evil.com' });
    expect(req.identity).toBeNull();
  });

  it('sets identity to null on whitespace/control characters', () => {
    const req = run({ 'tailscale-user-login': 'me @example.com' });
    expect(req.identity).toBeNull();
  });

  it('never throws on a malformed header', () => {
    expect(() =>
      run({ 'tailscale-user-login': ['a@b.com', 'c@d.com'] }),
    ).not.toThrow();
  });

  it('normalizes a valid login to lowercase and carries display fields through untrusted', () => {
    const req = run({
      'tailscale-user-login': '  Me@Example.com  ',
      'tailscale-user-name': 'Jane, Doe',
      'tailscale-user-profile-pic': ' https://example.com/pic.png ',
    });
    expect(req.identity).toEqual({
      login: 'me@example.com',
      name: 'Jane, Doe',
      profilePicUrl: 'https://example.com/pic.png',
    });
  });
});
