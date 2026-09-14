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
import { GitStatusEntry } from '../../../core/api.types';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * The Changes tab of the repo shell — `GET /git/status` (`api.gitStatus`),
 * grouped into four sections rather than rendered with the standard git
 * M/A/D badge set, because the server-side shape has no such code (F80,
 * `git-status-parser.ts`): `GitStatusEntry` is a discriminated union on
 * `kind` (`'ordinary' | 'renamed' | 'unmerged' | 'untracked'`), and
 * `ordinary`/`renamed`/`unmerged` entries each carry independent
 * `staged`/`unstaged` booleans (a partially-staged file can be true on
 * both, and therefore legitimately appears in both the Staged and
 * Unstaged sections at once).
 *
 * Sections: **Staged**, **Unstaged**, **Untracked**, **Conflicts**
 * (`kind === 'unmerged'`, its own section regardless of its staged flags —
 * a conflict is not simply "a staged or unstaged ordinary change").
 * Untracked entries carry no `staged`/`unstaged` flags at all (there is
 * nothing to diff against yet) and so are not tappable; every other
 * section's rows link to the diff route.
 */
@Component({
  selector: 'app-changes-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyState],
  templateUrl: './changes-tab.html',
  styleUrl: './changes-tab.scss',
})
export class ChangesTab {
  private readonly api = inject(ApiClient);

  readonly repo = input.required<string>();

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly entries = signal<GitStatusEntry[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly staged = computed(() =>
    this.entries().filter(
      (e) => e.kind !== 'unmerged' && e.kind !== 'untracked' && e.staged,
    ),
  );

  protected readonly unstaged = computed(() =>
    this.entries().filter(
      (e) => e.kind !== 'unmerged' && e.kind !== 'untracked' && e.unstaged,
    ),
  );

  protected readonly untracked = computed(() =>
    this.entries().filter((e) => e.kind === 'untracked'),
  );

  protected readonly conflicts = computed(() =>
    this.entries().filter((e) => e.kind === 'unmerged'),
  );

  protected readonly isEmpty = computed(() => this.entries().length === 0);

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load(this.repo());
  };

  constructor() {
    effect(() => {
      void this.load(this.repo());
    });
  }

  /** `path`/`origPath` may contain '/', so split into router-link segments. */
  protected repoSegments(): string[] {
    return this.repo()
      .split('/')
      .filter((segment) => segment.length > 0);
  }

  protected diffLink(): string[] {
    return ['/repo', ...this.repoSegments(), 'diff'];
  }

  protected diffQuery(entry: GitStatusEntry, staged: boolean): Record<string, string> {
    return { file: entry.path, staged: String(staged) };
  }

  private async load(repo: string): Promise<void> {
    this.status.set('loading');
    try {
      const result = await firstValueFrom(this.api.gitStatus(repo));
      this.entries.set(result.entries);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
