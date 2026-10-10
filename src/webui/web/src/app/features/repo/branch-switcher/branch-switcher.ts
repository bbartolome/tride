import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { BranchListResult } from '../../../core/api.types';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';

/**
 * Client-side-only confirmation text for a FORCE branch delete
 * (`git branch -D`). `GitBranchService.deleteBranch` has no server-side
 * confirmation gate, so this exists only to stop a stray tap; do not
 * present it as server-verified.
 */
const FORCE_DELETE_BRANCH_CONFIRM_TEXT = 'delete branch';

/**
 * Header branch dropdown of the repo shell: shows the current branch and,
 * when opened, lists local branches to check out, a name field to create a
 * new branch, and per-branch delete (soft `-d`; after it fails, a force
 * `-D` behind a client-side confirm).
 */
@Component({
  selector: 'app-branch-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './branch-switcher.html',
  styleUrl: './branch-switcher.scss',
})
export class BranchSwitcher {
  private readonly api = inject(ApiClient);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly repo = input.required<string>();
  readonly current = input<string | null>(null);
  readonly detached = input(false);
  /** Emits after any action that changed the repo (checkout, create, delete). */
  readonly changed = output<void>();

  protected readonly open = signal(false);
  protected readonly branches = signal<BranchListResult | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly busy = signal(false);
  protected readonly actionError = signal<ApiError | null>(null);
  protected readonly forceCandidate = signal<string | null>(null);
  protected readonly newBranchName = signal('');

  protected async toggle(): Promise<void> {
    const next = !this.open();
    this.open.set(next);
    if (next) {
      this.actionError.set(null);
      this.forceCandidate.set(null);
      await this.load();
    }
  }

  protected onNameInput(event: Event): void {
    this.newBranchName.set((event.target as HTMLInputElement).value);
  }

  protected async checkout(name: string): Promise<void> {
    if (name === this.branches()?.current) {
      this.open.set(false);
      return;
    }
    if (await this.runAction(() => this.api.gitCheckout(this.repo(), { branch: name }))) {
      this.open.set(false);
    }
  }

  protected async create(): Promise<void> {
    const name = this.newBranchName().trim();
    if (name.length === 0) {
      return;
    }
    if (await this.runAction(() => this.api.gitCreateBranch(this.repo(), { name }))) {
      this.newBranchName.set('');
    }
  }

  protected async remove(name: string): Promise<void> {
    this.forceCandidate.set(null);
    const ok = await this.runAction(() =>
      this.api.gitDeleteBranch(this.repo(), { name }),
    );
    if (!ok) {
      this.forceCandidate.set(name);
    }
  }

  protected async forceRemove(name: string): Promise<void> {
    const confirmed = await this.confirmDialog.open({
      title: `Force-delete "${name}"?`,
      body: `This deletes the local branch "${name}" even if it has commits not merged anywhere else — those commits can become unreachable and be garbage-collected. This confirmation is enforced only by this app, not by the server.`,
      requiredText: FORCE_DELETE_BRANCH_CONFIRM_TEXT,
    });
    if (!confirmed) {
      return;
    }
    this.forceCandidate.set(null);
    await this.runAction(() =>
      this.api.gitDeleteBranch(this.repo(), { name, force: true }),
    );
  }

  private async runAction(action: () => Observable<unknown>): Promise<boolean> {
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await firstValueFrom(action());
      this.changed.emit();
      await this.load();
      return true;
    } catch (err) {
      this.actionError.set(err as ApiError);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    this.loadError.set(null);
    try {
      this.branches.set(await firstValueFrom(this.api.gitBranches(this.repo())));
    } catch (err) {
      this.loadError.set(err as ApiError);
    }
  }
}
