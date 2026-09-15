import { LOGIN_RE, isValidLoginClientSide } from './login-pattern';

// LOGIN_RE must stay byte-for-byte identical to the server's `LOGIN_RE`
// (api/src/auth/users.types.ts). A drift here would let the add-user form
// accept a login the server then rejects with 400 VALIDATION_ERROR, or
// reject one the server would happily accept.
describe('LOGIN_RE', () => {
  it('has the exact same regex source as the server copy', () => {
    expect(LOGIN_RE.source).toBe('^[^\\s,@]{1,64}@[^\\s,@]{1,189}$');
  });

  it('matches user@example.com and the Tailscale user@github form', () => {
    expect(isValidLoginClientSide('user@example.com')).toBe(true);
    expect(isValidLoginClientSide('user@github')).toBe(true);
  });

  it('rejects logins missing an "@", containing whitespace, or containing a comma', () => {
    expect(isValidLoginClientSide('no-at-sign')).toBe(false);
    expect(isValidLoginClientSide('has space@example.com')).toBe(false);
    expect(isValidLoginClientSide('has,comma@example.com')).toBe(false);
  });

  it('rejects an empty string and enforces the length caps', () => {
    expect(isValidLoginClientSide('')).toBe(false);
    expect(isValidLoginClientSide(`${'a'.repeat(65)}@example.com`)).toBe(false);
    expect(isValidLoginClientSide(`user@${'a'.repeat(190)}`)).toBe(false);
  });
});
