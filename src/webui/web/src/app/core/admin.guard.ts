import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionStore } from './session.store';

/**
 * Admin-only gate for `/admin/users`, layered under the `/admin` parent
 * route which is itself `meGuard`-protected — by the time this guard runs,
 * `SessionStore.ensureLoaded()` has already resolved and `identity()` is
 * populated (or the parent guard has already redirected to `/denied` and
 * this guard never runs at all).
 *
 * An authenticated non-admin (`role: 'user'`) is legitimately inside the
 * app — they are on the allowlist, they just have no business on the admin
 * page — so they are redirected to `/`, NOT `/denied`. `/denied` is
 * reserved for allowlist rejection (401/403 from `/api/me`), which is
 * `meGuard`'s job, not this guard's.
 */
export const adminGuard: CanActivateFn = () => {
  const sessionStore = inject(SessionStore);
  const router = inject(Router);

  if (sessionStore.identity()?.role === 'admin') {
    return true;
  }
  return router.createUrlTree(['/']);
};
