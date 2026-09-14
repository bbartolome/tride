import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Reusable placeholder for "nothing here" and "this failed" states: a
 * message plus an optional retry action. T21 uses it for the repos list
 * (empty workspace / load error) and the directory browser (empty
 * directory / load error); T22–T26 reuse it for the same two situations
 * on their own screens, so the API is deliberately minimal — a message and
 * an optional retry callback — rather than tailored to any one page.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.scss',
})
export class EmptyState {
  readonly message = input.required<string>();
  /**
   * When present, a button is rendered that calls this on click. `null`
   * (the default) renders no button — plain empty states (e.g. "no repos
   * found") have nothing to retry.
   */
  readonly retry = input<(() => void) | null>(null);
  readonly retryLabel = input('Retry');
}
