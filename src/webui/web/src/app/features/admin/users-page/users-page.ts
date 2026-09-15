import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ApiError } from '../../../core/error.interceptor';
import { UserListEntry, UserRole } from '../../../core/api.types';
import { isValidLoginClientSide } from '../../../core/login-pattern';
import { SessionStore } from '../../../core/session.store';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { EmptyState } from '../../../shared/empty-state/empty-state';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

const SEEDED_REASON =
  'Seeded admins (set via WEBUI_ADMIN_LOGINS at boot) cannot be modified or removed here — see plan.md’s Auth section.';
const SELF_REMOVE_REASON = 'You cannot remove your own account.';

/**
 * `/admin/users` — admin-only user allowlist management (`GET/POST/PATCH/
 * DELETE /api/users`, `auth/users.controller.ts`). Gated by `adminGuard`,
 * itself nested under the `meGuard`-protected `/admin` parent route.
 *
 * Disabled-state precedence mirrors the server exactly (F30): the seeded
 * check happens BEFORE the self-removal check in `UsersController
 * .removeUser`, so a seeded admin trying to remove themselves gets
 * `SEEDED_IMMUTABLE`'s message, never the self-removal one.
 * `removeDisabledReason()` below checks `row.seeded` first for the same
 * reason.
 */
@Component({
  selector: 'app-users-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState],
  templateUrl: './users-page.html',
  styleUrl: './users-page.scss',
})
export class UsersPage {
  private readonly api = inject(ApiClient);
  private readonly sessionStore = inject(SessionStore);
  private readonly confirmDialog = inject(ConfirmDialogService);

  protected readonly seededReason = SEEDED_REASON;

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly users = signal<UserListEntry[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly actionBusy = signal(false);
  protected readonly actionError = signal<ApiError | null>(null);

  protected readonly newLogin = signal('');
  protected readonly newRole = signal<UserRole>('user');
  protected readonly formError = signal<string | null>(null);

  /** Bound into `<app-empty-state [retry]>` — must stay a stable identity. */
  protected readonly reload = (): void => {
    void this.load();
  };

  constructor() {
    void this.load();
  }

  protected onNewLoginInput(event: Event): void {
    this.newLogin.set((event.target as HTMLInputElement).value);
  }

  protected onNewRoleChange(event: Event): void {
    this.newRole.set((event.target as HTMLSelectElement).value as UserRole);
  }

  protected isSelf(row: UserListEntry): boolean {
    return row.login === this.sessionStore.identity()?.login;
  }

  /**
   * `null` means the role toggle is enabled. Seeded rows are the only
   * disabled case — the server has no self-role-change restriction, so
   * neither does this.
   */
  protected roleToggleDisabledReason(row: UserListEntry): string | null {
    return row.seeded ? SEEDED_REASON : null;
  }

  /**
   * `null` means remove is enabled. Order matters (F30): seeded is checked
   * FIRST, exactly like `UsersController.removeUser` — a seeded admin
   * removing themselves must see the seeded explanation, not the
   * self-removal one.
   */
  protected removeDisabledReason(row: UserListEntry): string | null {
    if (row.seeded) {
      return SEEDED_REASON;
    }
    if (this.isSelf(row)) {
      return SELF_REMOVE_REASON;
    }
    return null;
  }

  protected async addUser(): Promise<void> {
    const login = this.newLogin().trim();
    if (!isValidLoginClientSide(login)) {
      this.formError.set(
        'Login must look like user@example.com or user@github — no spaces or commas.',
      );
      return;
    }
    this.formError.set(null);
    await this.runAction(() => this.api.addUser(login, this.newRole()));
    this.newLogin.set('');
    this.newRole.set('user');
  }

  protected async toggleRole(row: UserListEntry): Promise<void> {
    if (this.roleToggleDisabledReason(row) !== null) {
      return;
    }
    const nextRole: UserRole = row.role === 'admin' ? 'user' : 'admin';
    await this.runAction(() => this.api.updateUserRole(row.login, nextRole));
  }

  protected async removeUser(row: UserListEntry): Promise<void> {
    if (this.removeDisabledReason(row) !== null) {
      return;
    }
    // Client-side-only confirmation — DELETE /api/users/:login has no
    // server-side CONFIRMATION_REQUIRED gate (unlike discard/force-push),
    // so this guards only against a stray tap, not against a bypass.
    const confirmed = await this.confirmDialog.open({
      title: `Remove ${row.login}?`,
      body: `This immediately revokes ${row.login}'s access to this app. This confirmation is enforced only by this app, not by the server.`,
      requiredText: row.login,
    });
    if (!confirmed) {
      return;
    }
    await this.runAction(() => this.api.removeUser(row.login));
  }

  private async runAction(action: () => Observable<unknown>): Promise<void> {
    this.actionBusy.set(true);
    this.actionError.set(null);
    try {
      await firstValueFrom(action());
      await this.load();
    } catch (err) {
      this.actionError.set(err as ApiError);
    } finally {
      this.actionBusy.set(false);
    }
  }

  private async load(): Promise<void> {
    this.status.set('loading');
    try {
      const users = await firstValueFrom(this.api.listUsers());
      this.users.set(users);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
