import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { StashEntry } from '../../../core/api.types';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * The Stash tab of the repo shell — `GET /git/stash` (`api.gitStashList`).
 * Push (with an optional message and "include untracked"), apply, pop,
 * and drop, each a thin call onto the matching `ApiClient` method,
 * reloading the list on success.
 */
@Component({
  selector: 'app-stash-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState],
  templateUrl: './stash-tab.html',
  styleUrl: './stash-tab.scss',
})
export class StashTab {
  private readonly api = inject(ApiClient);

  readonly repo = input.required<string>();

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly entries = signal<StashEntry[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly actionBusy = signal(false);
  protected readonly actionError = signal<ApiError | null>(null);

  protected readonly pushMessage = signal('');
  protected readonly includeUntracked = signal(false);

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load(this.repo());
  };

  constructor() {
    effect(() => {
      void this.load(this.repo());
    });
  }

  protected onPushMessageInput(event: Event): void {
    this.pushMessage.set((event.target as HTMLInputElement).value);
  }

  protected onIncludeUntrackedChange(event: Event): void {
    this.includeUntracked.set((event.target as HTMLInputElement).checked);
  }

  protected async push(): Promise<void> {
    const message = this.pushMessage().trim();
    await this.runAction(() =>
      this.api.gitStashPush(this.repo(), {
        message: message.length > 0 ? message : undefined,
        includeUntracked: this.includeUntracked(),
      }),
    );
    this.pushMessage.set('');
    this.includeUntracked.set(false);
  }

  protected async apply(ref: string): Promise<void> {
    await this.runAction(() => this.api.gitStashApply(this.repo(), ref));
  }

  protected async pop(ref: string): Promise<void> {
    await this.runAction(() => this.api.gitStashPop(this.repo(), ref));
  }

  protected async drop(ref: string): Promise<void> {
    await this.runAction(() => this.api.gitStashDrop(this.repo(), ref));
  }

  private async runAction(action: () => Observable<unknown>): Promise<void> {
    this.actionBusy.set(true);
    this.actionError.set(null);
    try {
      await firstValueFrom(action());
      await this.load(this.repo());
    } catch (err) {
      this.actionError.set(err as ApiError);
    } finally {
      this.actionBusy.set(false);
    }
  }

  private async load(repo: string): Promise<void> {
    this.status.set('loading');
    try {
      const result = await firstValueFrom(this.api.gitStashList(repo));
      this.entries.set(result);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
