import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { BranchListResult } from '../../../core/api.types';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Client-side-only confirmation text for a FORCE branch delete
 * (`git branch -D`). Unlike discard/force-push, `DeleteBranchOptions` has
 * no server-side `CONFIRMATION_REQUIRED` gate (`GitBranchService
 * .deleteBranch` never checks a `confirm` field) — this dialog exists
 * purely so the app doesn't let a stray tap fire off an unmerged-branch
 * deletion, but the server would honor `force: true` with no confirmation
 * at all if this were ever bypassed. Do not present this as
 * server-verified the way `DISCARD_CONFIRM_TEXT`/`FORCE_PUSH_CONFIRM_TEXT`
 * are.
 */
const FORCE_DELETE_BRANCH_CONFIRM_TEXT = 'delete branch';

/**
 * The Branches tab of the repo shell — `GET /git/branches`
 * (`api.gitBranches`): current/detached HEAD, local branches (with
 * upstream + ahead/behind), and remote-tracking branches. Actions:
 * checkout an existing local branch, create a new one (optionally from a
 * start point), and delete (soft `-d`, or force `-D` behind a client-side
 * confirm — see `FORCE_DELETE_BRANCH_CONFIRM_TEXT`'s doc comment).
 */
@Component({
  selector: 'app-branches-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState],
  templateUrl: './branches-tab.html',
  styleUrl: './branches-tab.scss',
})
export class BranchesTab {
  private readonly api = inject(ApiClient);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly repo = input.required<string>();

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly branches = signal<BranchListResult | null>(null);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly actionBusy = signal(false);
  protected readonly actionError = signal<ApiError | null>(null);

  protected readonly newBranchName = signal('');
  protected readonly newBranchStartPoint = signal('');

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load(this.repo());
  };

  constructor() {
    effect(() => {
      void this.load(this.repo());
    });
  }

  protected onNewBranchNameInput(event: Event): void {
    this.newBranchName.set((event.target as HTMLInputElement).value);
  }

  protected onNewBranchStartPointInput(event: Event): void {
    this.newBranchStartPoint.set((event.target as HTMLInputElement).value);
  }

  protected async checkout(name: string): Promise<void> {
    await this.runAction(() => this.api.gitCheckout(this.repo(), { branch: name }));
  }

  protected async createBranch(): Promise<void> {
    const name = this.newBranchName().trim();
    if (name.length === 0) {
      return;
    }
    const startPoint = this.newBranchStartPoint().trim();
    await this.runAction(() =>
      this.api.gitCreateBranch(this.repo(), {
        name,
        startPoint: startPoint.length > 0 ? startPoint : undefined,
      }),
    );
    this.newBranchName.set('');
    this.newBranchStartPoint.set('');
  }

  protected async deleteBranch(name: string): Promise<void> {
    await this.runAction(() => this.api.gitDeleteBranch(this.repo(), { name }));
  }

  protected async forceDeleteBranch(name: string): Promise<void> {
    // Client-side-only confirmation — see `FORCE_DELETE_BRANCH_CONFIRM_TEXT`.
    const confirmed = await this.confirmDialog.open({
      title: `Force-delete "${name}"?`,
      body: `This deletes the local branch "${name}" even if it has commits not merged anywhere else — those commits can become unreachable and be garbage-collected. This confirmation is enforced only by this app, not by the server.`,
      requiredText: FORCE_DELETE_BRANCH_CONFIRM_TEXT,
    });
    if (!confirmed) {
      return;
    }
    await this.runAction(() =>
      this.api.gitDeleteBranch(this.repo(), { name, force: true }),
    );
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
      const result = await firstValueFrom(this.api.gitBranches(repo));
      this.branches.set(result);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
