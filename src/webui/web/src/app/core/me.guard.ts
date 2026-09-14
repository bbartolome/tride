import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionStore } from './session.store';

/**
 * Loads `/api/me` (once — `SessionStore.ensureLoaded()` is idempotent) and
 * redirects to `/denied` when the server rejected it with 401 or 403.
 * `error` (a real 5xx/network failure) is deliberately let through rather
 * than also redirected to `/denied` — that route is specifically the
 * "you are not allowed" state, not a general error page, so a transient
 * backend failure surfaces to the routed component instead of being
 * mislabeled as an access denial.
 */
export const meGuard: CanActivateFn = async () => {
  const sessionStore = inject(SessionStore);
  const router = inject(Router);

  await sessionStore.ensureLoaded();

  if (sessionStore.status() === 'denied') {
    return router.createUrlTree(['/denied']);
  }
  return true;
};
