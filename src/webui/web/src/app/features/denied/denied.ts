import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SessionStore } from '../../core/session.store';

/**
 * `/denied` — landing page for both 401 `AUTH_REQUIRED` and 403
 * `NOT_ALLOWED` from `GET /api/me` (`meGuard` routes here for either).
 *
 * Only the 403 case carries a rejected login: Tailscale Serve injects the
 * `Tailscale-User-Login` header server-side, invisibly to client JS, so the
 * ONLY way this page can show which login was rejected is the server
 * echoing it back in the error envelope's `detail.login`
 * (`TailscaleAuthGuard`'s `NOT_ALLOWED` throw). The 401 case has no
 * identity at all — there is no login to report, so `rejectedLogin()` is
 * `null` and a generic "no identity presented" message is shown instead of
 * assuming `detail.login` is always there.
 */
@Component({
  selector: 'app-denied',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './denied.html',
  styleUrl: './denied.scss',
})
export class Denied {
  private readonly sessionStore = inject(SessionStore);
  protected readonly error = this.sessionStore.error;

  protected readonly rejectedLogin = computed<string | null>(() => {
    const err = this.sessionStore.error();
    if (err === null || typeof err.detail !== 'object' || err.detail === null) {
      return null;
    }
    const login = (err.detail as { login?: unknown }).login;
    return typeof login === 'string' ? login : null;
  });
}
