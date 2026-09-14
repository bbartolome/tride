import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Placeholder — T21 replaces this with the real repo list/browser. Exists
 * now only so `/` has somewhere to route to and the shell/guard/nav wiring
 * has something real to navigate between.
 */
@Component({
  selector: 'app-repos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="placeholder">Repos — coming soon.</p>`,
  styles: `
    .placeholder {
      padding: 1rem;
      text-align: center;
      color: var(--muted, #666);
    }
  `,
})
export class Repos {}
