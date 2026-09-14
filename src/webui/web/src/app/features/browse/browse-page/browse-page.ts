import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { TreeEntry } from '../../../core/api.types';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface Breadcrumb {
  label: string;
  /** Workspace-relative path this crumb links to ('' = workspace root). */
  path: string;
}

/**
 * Matcher route (see `browse.matcher.ts`) — `path` arrives as a route
 * param bound by `withComponentInputBinding()`, workspace-relative and
 * already `/`-joined (e.g. `''`, `'a'`, `'a/b/c'`).
 */
@Component({
  selector: 'app-browse-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyState],
  templateUrl: './browse-page.html',
  styleUrl: './browse-page.scss',
})
export class BrowsePage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  readonly path = input<string>('');

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly entries = signal<TreeEntry[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly sortedEntries = computed(() => {
    // Directories first, then files; alphabetical within each group.
    return [...this.entries()].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  });

  protected readonly segments = computed(() =>
    this.path()
      .split('/')
      .filter((segment) => segment.length > 0),
  );

  protected readonly breadcrumbs = computed<Breadcrumb[]>(() => {
    const segments = this.segments();
    const crumbs: Breadcrumb[] = [{ label: 'workspace', path: '' }];
    for (let i = 0; i < segments.length; i++) {
      crumbs.push({
        label: segments[i],
        path: segments.slice(0, i + 1).join('/'),
      });
    }
    return crumbs;
  });

  /** null at the workspace root — there is nowhere to go "up" to. */
  protected readonly parentPath = computed<string | null>(() => {
    const segments = this.segments();
    return segments.length > 0 ? segments.slice(0, -1).join('/') : null;
  });

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load(this.path());
  };

  constructor() {
    effect(() => {
      void this.load(this.path());
    });
  }

  protected browseLink(path: string): string[] {
    return ['/browse', ...path.split('/').filter((s) => s.length > 0)];
  }

  protected repoLink(entryName: string): string[] {
    return [
      '/repo',
      ...this.entryPath(entryName)
        .split('/')
        .filter((s) => s.length > 0),
    ];
  }

  /** Workspace-relative path of `name` inside the directory being browsed. */
  protected entryPath(name: string): string {
    return this.joinPath(this.path(), name);
  }

  protected async openTerminalHere(entry: TreeEntry): Promise<void> {
    // A file isn't a valid cwd — for a file row the "here" is the
    // directory currently being browsed; for a directory row it's that
    // directory itself.
    const cwd =
      entry.type === 'dir' ? this.joinPath(this.path(), entry.name) : this.path();
    try {
      const terminal = await firstValueFrom(
        this.api.createTerminal(cwd, { mode: 'shell' }),
      );
      // The terminal view arrives in T24 — navigating here anyway; a
      // missing route today is a T24 problem, not a reason to withhold
      // this action.
      await this.router.navigate(['/terminal', terminal.id]);
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }

  private joinPath(base: string, name: string): string {
    return base ? `${base}/${name}` : name;
  }

  private async load(path: string): Promise<void> {
    this.status.set('loading');
    try {
      const tree = await firstValueFrom(this.api.fsTree(path));
      this.entries.set(tree.entries);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
