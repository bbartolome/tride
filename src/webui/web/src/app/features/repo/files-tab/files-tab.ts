import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { TreeEntry } from '../../../core/api.types';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * The Browse tab of the repo shell — lists the repo's directories and files
 * (`api.fsTree`), navigating into subdirectories inside the tab so the repo
 * header and tab bar stay put.
 */
@Component({
  selector: 'app-files-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState],
  templateUrl: './files-tab.html',
  styleUrl: './files-tab.scss',
})
export class FilesTab {
  private readonly api = inject(ApiClient);

  readonly repo = input.required<string>();

  /** Path inside the repo; '' is the repo root. */
  protected readonly subPath = signal('');
  protected readonly status = signal<LoadStatus>('idle');
  protected readonly entries = signal<TreeEntry[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly sortedEntries = computed(() =>
    [...this.entries()].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    }),
  );

  protected readonly breadcrumbs = computed(() => {
    const segments = this.subPath().split('/').filter((s) => s.length > 0);
    const root = this.repo().split('/').filter((s) => s.length > 0).pop() ?? '';
    const crumbs = [{ label: root, path: '' }];
    segments.forEach((segment, i) => {
      crumbs.push({ label: segment, path: segments.slice(0, i + 1).join('/') });
    });
    return crumbs;
  });

  protected readonly reload = (): void => {
    void this.load(this.repo(), this.subPath());
  };

  constructor() {
    effect(() => {
      void this.load(this.repo(), this.subPath());
    });
  }

  protected open(name: string): void {
    const current = this.subPath();
    this.subPath.set(current ? `${current}/${name}` : name);
  }

  protected goTo(path: string): void {
    this.subPath.set(path);
  }

  private async load(repo: string, sub: string): Promise<void> {
    this.status.set('loading');
    try {
      const tree = await firstValueFrom(
        this.api.fsTree(sub ? `${repo}/${sub}` : repo),
      );
      this.entries.set(tree.entries);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
