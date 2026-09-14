import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { GitCommitInfo, GitLogEntry } from '../../../core/api.types';
import { Hunk, parseUnifiedDiff } from '../../../core/diff-parser';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { HunkList } from '../../../shared/hunk-list/hunk-list';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** `GET /git/log`'s page size — "load more" bumps `skip` by exactly this
 * much on every click, regardless of how many rows the previous page
 * actually returned. */
const PAGE_SIZE = 30;

/**
 * The Log tab of the repo shell — `GET /git/log` (`api.gitLog`), paged
 * with `limit`/`skip`. "Load more" appends the next page and bumps `skip`
 * by `PAGE_SIZE`; `hasMore` goes false once a page comes back shorter
 * than `PAGE_SIZE` (the ordinary end-of-history signal).
 *
 * Tapping a commit calls `GET /git/show` (`api.gitShow`) and renders its
 * `diffText` through the SAME `parseUnifiedDiff` + `HunkList` T22 already
 * built for the diff viewer (F168) — no second hunk renderer.
 */
@Component({
  selector: 'app-log-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, HunkList],
  templateUrl: './log-tab.html',
  styleUrl: './log-tab.scss',
})
export class LogTab {
  private readonly api = inject(ApiClient);

  readonly repo = input.required<string>();

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly entries = signal<GitLogEntry[]>([]);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly hasMore = signal(true);
  private skip = 0;

  protected readonly selectedSha = signal<string | null>(null);
  protected readonly detailStatus = signal<LoadStatus>('idle');
  protected readonly detailHeader = signal<GitCommitInfo | null>(null);
  protected readonly detailText = signal<string | null>(null);
  protected readonly detailError = signal<ApiError | null>(null);

  protected readonly detailHunks = computed<Hunk[]>(() => {
    const text = this.detailText();
    return text === null ? [] : parseUnifiedDiff(text);
  });

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.reset(this.repo());
  };

  constructor() {
    effect(() => {
      void this.reset(this.repo());
    });
  }

  protected async loadMore(): Promise<void> {
    if (this.status() === 'loading') {
      return;
    }
    await this.loadPage(this.repo());
  }

  protected async selectCommit(entry: GitLogEntry): Promise<void> {
    this.selectedSha.set(entry.sha);
    this.detailStatus.set('loading');
    this.detailHeader.set(null);
    this.detailText.set(null);
    this.detailError.set(null);
    try {
      const result = await firstValueFrom(this.api.gitShow(this.repo(), entry.sha));
      this.detailHeader.set(result.header);
      this.detailText.set(result.diffText);
      this.detailStatus.set('loaded');
    } catch (err) {
      this.detailError.set(err as ApiError);
      this.detailStatus.set('error');
    }
  }

  protected closeDetail(): void {
    this.selectedSha.set(null);
  }

  protected firstLine(message: string): string {
    return message.split('\n', 1)[0];
  }

  protected shortSha(sha: string): string {
    return sha.slice(0, 7);
  }

  private async reset(repo: string): Promise<void> {
    this.entries.set([]);
    this.skip = 0;
    this.hasMore.set(true);
    this.selectedSha.set(null);
    await this.loadPage(repo);
  }

  private async loadPage(repo: string): Promise<void> {
    this.status.set('loading');
    try {
      const page = await firstValueFrom(
        this.api.gitLog(repo, { limit: PAGE_SIZE, skip: this.skip }),
      );
      this.entries.update((existing) => [...existing, ...page]);
      this.skip += PAGE_SIZE;
      if (page.length < PAGE_SIZE) {
        this.hasMore.set(false);
      }
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
