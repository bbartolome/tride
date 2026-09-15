import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { TerminalMode, TerminalSummary } from '../../../core/api.types';
import { CLAUDE_LABEL_RE } from '../../../core/terminal-label';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * `/terminals` — every open tmux session (shell or claude) as a card, plus
 * a "New terminal" form.
 *
 * `TerminalSummary.cwd` is already workspace-relative (F128) — rendered
 * directly, with no attempt to "prettify" an absolute path that was never
 * there in the first place.
 *
 * Delete uses a light `window.confirm()`, NOT the typed
 * `ConfirmDialogService` — that dialog is reserved for destructive git
 * operations (discard/force-push/force-delete-branch) where a stray tap
 * could lose history; closing a terminal is comparatively low-stakes and
 * tmux sessions are cheap to recreate.
 */
@Component({
  selector: 'app-terminals-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, EmptyState],
  templateUrl: './terminals-list.html',
  styleUrl: './terminals-list.scss',
})
export class TerminalsList {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly terminals = signal<TerminalSummary[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly newCwd = signal('');
  protected readonly newMode = signal<TerminalMode>('shell');
  protected readonly newLabel = signal('');
  protected readonly createBusy = signal(false);
  protected readonly createErrorMessage = signal<string | null>(null);

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load();
  };

  constructor() {
    void this.load();
  }

  protected onCwdInput(event: Event): void {
    this.newCwd.set((event.target as HTMLInputElement).value);
  }

  protected onModeChange(event: Event): void {
    this.newMode.set((event.target as HTMLSelectElement).value as TerminalMode);
  }

  protected onLabelInput(event: Event): void {
    this.newLabel.set((event.target as HTMLInputElement).value);
  }

  protected async createTerminal(): Promise<void> {
    const cwd = this.newCwd().trim();
    if (cwd.length === 0) {
      this.createErrorMessage.set('Directory is required.');
      return;
    }
    const mode = this.newMode();
    const label = this.newLabel().trim();
    if (mode === 'claude' && !CLAUDE_LABEL_RE.test(label)) {
      // Validated client-side before ever hitting the network — the
      // server enforces the exact same pattern, but a 400 round-trip for
      // a leading dash or a blank label is a poor experience.
      this.createErrorMessage.set(
        'Label is required for Claude terminals: start with a letter or digit, then letters, digits, "." "_" or "-" (max 64 characters).',
      );
      return;
    }

    this.createBusy.set(true);
    this.createErrorMessage.set(null);
    try {
      const terminal = await firstValueFrom(
        this.api.createTerminal(cwd, {
          mode,
          label: mode === 'claude' ? label : label.length > 0 ? label : undefined,
        }),
      );
      await this.router.navigate(['/terminal', terminal.id]);
    } catch (err) {
      this.createErrorMessage.set((err as ApiError).message);
    } finally {
      this.createBusy.set(false);
    }
  }

  protected async remove(terminal: TerminalSummary, event: Event): Promise<void> {
    // The card itself is a routerLink `<a>` — stop this button's click
    // from also triggering navigation into the terminal we're closing.
    event.preventDefault();
    event.stopPropagation();
    if (
      !window.confirm(`Close terminal "${terminal.label}"? This ends the session.`)
    ) {
      return;
    }
    try {
      await firstValueFrom(this.api.removeTerminal(terminal.id));
      await this.load();
    } catch (err) {
      this.error.set(err as ApiError);
    }
  }

  protected displayCwd(cwd: string): string {
    return cwd.length > 0 ? cwd : '(workspace root)';
  }

  private async load(): Promise<void> {
    this.status.set('loading');
    try {
      const terminals = await firstValueFrom(this.api.listTerminals());
      this.terminals.set(terminals);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
