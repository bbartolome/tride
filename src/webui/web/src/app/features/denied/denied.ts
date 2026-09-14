import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SessionStore } from '../../core/session.store';

/**
 * Minimal placeholder — T25 finishes this screen (proper copy, contact
 * info, retry). For now it just confirms the guard routed here correctly
 * and surfaces whatever the server said.
 */
@Component({
  selector: 'app-denied',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="denied">
      <h1>Access denied</h1>
      <p>Your Tailscale identity is not on this app's allowlist.</p>
      @if (error(); as err) {
        <p class="detail">{{ err.code }}: {{ err.message }}</p>
      }
    </div>
  `,
  styles: `
    .denied {
      padding: 2rem 1rem;
      text-align: center;
    }
    .detail {
      color: var(--muted, #666);
      font-size: 0.875rem;
    }
  `,
})
export class Denied {
  private readonly sessionStore = inject(SessionStore);
  protected readonly error = this.sessionStore.error;
}
