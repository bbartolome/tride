/**
 * Client-side mirror of the server's login validation regex, copied
 * byte-for-byte from `api/src/auth/users.types.ts`'s `LOGIN_RE`:
 *
 *   const LOGIN_RE = /^[^\s,@]{1,64}@[^\s,@]{1,189}$/;
 *
 * The two packages share no build (no shared package, no `.d.ts`
 * re-export), so this constant — and the spec pinning it — is the only
 * drift control, following `confirm-literals.ts`'s convention. Used to
 * validate the login field in the admin add-user form before it ever
 * reaches the server, which would otherwise reject it with 400
 * `VALIDATION_ERROR`.
 *
 * Matches both `user@example.com` and Tailscale's `user@github` form.
 */
export const LOGIN_RE = /^[^\s,@]{1,64}@[^\s,@]{1,189}$/;

export function isValidLoginClientSide(value: string): boolean {
  return LOGIN_RE.test(value);
}
