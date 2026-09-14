import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { RepoSummary } from '../../../core/api.types';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * `/` — one card per repo under the workspace root.
 *
 * `RepoSummary.path` (F63) is workspace-relative and is the *exact* value
 * every other endpoint (`/api/git/*`, terminal `cwd`, …) expects back —
 * it is what we split into route segments for `/repo/<path>` below, so a
 * card's navigation target and its identifier everywhere else in the app
 * are always the same string.
 *
 * `dirty` is a boolean, not a changed-file count (F63's shape has no such
 * count) — rendered as a clean/dirty dot. A real count would need an N+1
 * `/api/git/status` fetch per card just to populate a list of cards; the
 * dot is the correct trade-off here, not a shortcut.
 */
@Component({
  selector: 'app-repos-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyState],
  templateUrl: './repos-page.html',
  styleUrl: './repos-page.scss',
})
export class ReposPage {
  private readonly api = inject(ApiClient);

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly repos = signal<RepoSummary[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load();
  };

  constructor() {
    void this.load();
  }

  protected refresh(): void {
    // Busts the API's own 30s server-side cache (?refresh=1). No
    // client-side cache here — the server owns that, per F63.
    void this.load(true);
  }

  /** `path` may contain '/', so split it into router-link segments. */
  protected repoSegments(path: string): string[] {
    return path.split('/').filter((segment) => segment.length > 0);
  }

  private async load(refresh = false): Promise<void> {
    this.status.set('loading');
    try {
      const repos = await firstValueFrom(this.api.listRepos(refresh));
      this.repos.set(repos);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
