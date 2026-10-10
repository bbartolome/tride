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
import { Observable, firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { FORCE_PUSH_CONFIRM_TEXT } from '../../../core/confirm-literals';
import { ApiError } from '../../../core/error.interceptor';
import { GitStatusResult } from '../../../core/api.types';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { BranchesTab } from '../branches-tab/branches-tab';
import { ChangesTab } from '../changes-tab/changes-tab';
import { LogTab } from '../log-tab/log-tab';
import { StashTab } from '../stash-tab/stash-tab';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

type RepoTab = 'changes' | 'branches' | 'log' | 'stash';

const TABS: { id: RepoTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'branches', label: 'Branches' },
  { id: 'log', label: 'Log' },
  { id: 'stash', label: 'Stash' },
];

type RemoteActionKind = 'fetch' | 'pull' | 'push' | 'force-push';

/**
 * `/repo/<repo path>` (`repoMatcher`, F159) — the repo shell: a header
 * (repo name, branch, ahead/behind), a fetch/pull/push toolbar, and a
 * four-tab bar (Changes/Branches/Log/Stash — all four have real content
 * as of T23, F171).
 *
 * The header's branch/ahead/behind figures come from `GET /git/status`
 * (the same call `ChangesTab` makes independently for its own entries) —
 * each component owns its own data the way `ReposPage`/`BrowsePage` do,
 * rather than threading state down through inputs.
 *
 * **Remote actions (fetch/pull/push).** `GIT_AUTH_REQUIRED` (502) is
 * rendered as its OWN first-class state (`remoteAuthRequired`), never
 * folded into the generic `remoteError` banner: a passphrase-protected
 * key or a missing credential helper is the expected case for this app
 * (there is no UI for entering credentials, by design — plan.md), not an
 * exceptional one, so it gets a one-tap "Open a terminal in this repo"
 * button (reusing `openTerminalHere`) instead of a dead-end error toast.
 * This is deliberately distinct from the LOGIN `AUTH_REQUIRED` 401
 * (`SessionStore`/`meGuard`) — same-sounding code, unrelated meaning
 * (F100/F101).
 *
 * Force push requires the typed confirmation dialog
 * (`FORCE_PUSH_CONFIRM_TEXT`, mirrored from the server, F89) before the
 * request is ever sent; the server always runs it as
 * `--force-with-lease --force-if-includes` — there is no plain `--force`
 * path anywhere in this app.
 *
 * The sticky "Open terminal here" button is the designed escape hatch
 * (plan.md) for merge/rebase/conflict work the API deliberately does not
 * expose — present on every repo page, not just this one's header.
 */
@Component({
  selector: 'app-repo-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ChangesTab, BranchesTab, LogTab, StashTab],
  templateUrl: './repo-shell.html',
  styleUrl: './repo-shell.scss',
})
export class RepoShell {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly repo = input.required<string>();

  protected readonly tabs = TABS;
  protected readonly activeTab = signal<RepoTab>('changes');

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly summary = signal<GitStatusResult | null>(null);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly browseLink = computed(() => [
    '/browse',
    ...this.repo()
      .split('/')
      .filter((s) => s.length > 0),
  ]);

  protected readonly repoName = computed(() => {
    const segments = this.repo()
      .split('/')
      .filter((s) => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : this.repo();
  });

  protected readonly terminalBusy = signal(false);

  protected readonly remoteBusy = signal<RemoteActionKind | null>(null);
  protected readonly remoteError = signal<ApiError | null>(null);
  /** True only for a 502 `GIT_AUTH_REQUIRED` — every other remote failure
   * renders through `remoteError` instead. */
  protected readonly remoteAuthRequired = computed(
    () => this.remoteError()?.code === 'GIT_AUTH_REQUIRED',
  );

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

  protected async fetch(): Promise<void> {
    await this.runRemoteAction('fetch', () => this.api.gitFetch(this.repo()));
  }

  protected async pull(): Promise<void> {
    await this.runRemoteAction('pull', () => this.api.gitPull(this.repo()));
  }

  protected async push(): Promise<void> {
    await this.runRemoteAction('push', () => this.api.gitPush(this.repo()));
  }

  protected async forcePush(): Promise<void> {
    // Typed confirmation BEFORE the request is ever sent — mirrors the
    // server's own gate (F89). The server always runs this as
    // `--force-with-lease --force-if-includes`; there is no plain
    // `--force` code path to opt into.
    const confirmed = await this.confirmDialog.open({
      title: 'Force push?',
      body: `This force-pushes "${this.repoName()}" to its upstream, overwriting the remote branch's history to match your local branch (using --force-with-lease, so it fails safely if the remote moved since your last fetch). This cannot be undone on the remote.`,
      requiredText: FORCE_PUSH_CONFIRM_TEXT,
    });
    if (!confirmed) {
      return;
    }
    await this.runRemoteAction('force-push', () =>
      this.api.gitPush(this.repo(), { force: true, confirm: FORCE_PUSH_CONFIRM_TEXT }),
    );
  }

  private async runRemoteAction(
    kind: RemoteActionKind,
    action: () => Observable<unknown>,
  ): Promise<void> {
    this.remoteBusy.set(kind);
    this.remoteError.set(null);
    try {
      await firstValueFrom(action());
      await this.load(this.repo());
    } catch (err) {
      this.remoteError.set(err as ApiError);
    } finally {
      this.remoteBusy.set(null);
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
