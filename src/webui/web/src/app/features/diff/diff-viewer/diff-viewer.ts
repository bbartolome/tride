import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { Hunk, parseUnifiedDiff } from '../../../core/diff-parser';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

const DEFAULT_CONTEXT = 3;

/**
 * `/repo/<repo path>/diff` (`repoDiffMatcher`, F159) — `file` and `staged`
 * arrive as QUERY params (mirroring `GET /git/diff?path=&staged=`
 * directly), not path segments, bound the same way `repo` is via
 * `withComponentInputBinding()`.
 *
 * Single column, collapsible hunks (one boolean per hunk index — expanded
 * by default). Parsing goes through the pure `parseUnifiedDiff` (no
 * `diff2html`, per plan.md — its side-by-side default is wrong for a
 * phone). The `{binary: true}` half of `DiffResponse` (F80) is handled as
 * its own "binary file, no preview" state rather than ever being handed
 * to the parser.
 */
@Component({
  selector: 'app-diff-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyState],
  templateUrl: './diff-viewer.html',
  styleUrl: './diff-viewer.scss',
})
export class DiffViewer {
  private readonly api = inject(ApiClient);

  readonly repo = input.required<string>();
  readonly file = input<string>();
  /** Raw query-param string ('true'/'false') — query params bind as strings. */
  readonly staged = input<string>();

  protected readonly stagedBool = computed(() => this.staged() === 'true');

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly text = signal<string | null>(null);
  protected readonly binary = signal(false);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly hunks = computed<Hunk[]>(() => {
    const text = this.text();
    return text === null ? [] : parseUnifiedDiff(text);
  });

  /** Indices of collapsed hunks; absent = expanded. */
  protected readonly collapsedHunks = signal<ReadonlySet<number>>(new Set());

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load();
  };

  protected readonly repoSegments = computed(() =>
    this.repo()
      .split('/')
      .filter((s) => s.length > 0),
  );

  constructor() {
    effect(() => {
      // Track repo/file/staged so a query-param-only navigation (e.g.
      // tapping a different file's diff link) reloads too.
      this.repo();
      this.file();
      this.staged();
      void this.load();
    });
  }

  protected isCollapsed(index: number): boolean {
    return this.collapsedHunks().has(index);
  }

  protected toggleHunk(index: number): void {
    const next = new Set(this.collapsedHunks());
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    this.collapsedHunks.set(next);
  }

  private async load(): Promise<void> {
    const file = this.file();
    if (!file) {
      this.status.set('error');
      this.error.set({
        status: 0,
        code: 'VALIDATION_ERROR',
        message: 'No file specified.',
      });
      return;
    }

    this.status.set('loading');
    this.binary.set(false);
    this.text.set(null);
    this.collapsedHunks.set(new Set());
    try {
      const response = await firstValueFrom(
        this.api.gitDiff(this.repo(), {
          path: file,
          staged: this.stagedBool(),
          context: DEFAULT_CONTEXT,
        }),
      );
      if ('binary' in response && response.binary) {
        this.binary.set(true);
      } else if ('text' in response) {
        this.text.set(response.text);
      }
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
