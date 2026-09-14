import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { GitStatusResult } from '../../../core/api.types';
import { ChangesTab } from '../changes-tab/changes-tab';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

type RepoTab = 'changes' | 'branches' | 'log' | 'stash';

const TABS: { id: RepoTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'branches', label: 'Branches' },
  { id: 'log', label: 'Log' },
  { id: 'stash', label: 'Stash' },
];

/**
 * `/repo/<repo path>` (`repoMatcher`, F159) — the repo shell: a header
 * (repo name, branch, ahead/behind) plus a four-tab bar. Only **Changes**
 * has real content in this task (T22); Branches / Log / Stash render as
 * existing-but-empty tabs so T23 can drop content into them without
 * restructuring this shell.
 *
 * The header's branch/ahead/behind figures come from `GET /git/status`
 * (the same call `ChangesTab` makes independently for its own entries) —
 * each component owns its own data the way `ReposPage`/`BrowsePage` do,
 * rather than threading state down through inputs.
 *
 * The sticky "Open terminal here" button is the designed escape hatch
 * (plan.md) for merge/rebase/conflict work the API deliberately does not
 * expose — present on every repo page, not just this one's header.
 */
@Component({
  selector: 'app-repo-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChangesTab],
  templateUrl: './repo-shell.html',
  styleUrl: './repo-shell.scss',
})
export class RepoShell {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  readonly repo = input.required<string>();

  protected readonly tabs = TABS;
  protected readonly activeTab = signal<RepoTab>('changes');

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly summary = signal<GitStatusResult | null>(null);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly repoName = computed(() => {
    const segments = this.repo()
      .split('/')
      .filter((s) => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : this.repo();
  });

  protected readonly terminalBusy = signal(false);

  constructor() {
    effect(() => {
      void this.load(this.repo());
    });
  }

  protected selectTab(tab: RepoTab): void {
    this.activeTab.set(tab);
  }

  protected async openTerminalHere(): Promise<void> {
    this.terminalBusy.set(true);
    try {
      const terminal = await firstValueFrom(
        this.api.createTerminal(this.repo(), { mode: 'shell' }),
      );
      await this.router.navigate(['/terminal', terminal.id]);
    } catch (err) {
      this.error.set(err as ApiError);
    } finally {
      this.terminalBusy.set(false);
    }
  }

  private async load(repo: string): Promise<void> {
    this.status.set('loading');
    try {
      const result = await firstValueFrom(this.api.gitStatus(repo));
      this.summary.set(result);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
