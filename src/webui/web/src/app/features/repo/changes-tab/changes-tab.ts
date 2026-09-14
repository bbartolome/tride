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
import { Observable, firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { DISCARD_CONFIRM_TEXT } from '../../../core/confirm-literals';
import { ApiError } from '../../../core/error.interceptor';
import { GitStatusEntry } from '../../../core/api.types';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** Which section a row's checkbox lives in — see the class doc's note on
 * selection keys. */
type SelectionSection = 'staged' | 'unstaged' | 'untracked';

function selectionKey(section: SelectionSection, path: string): string {
  return `${section}::${path}`;
}

function distinct(paths: string[]): string[] {
  return [...new Set(paths)];
}

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
 * section's rows link to the diff route. Conflicts are read-only here —
 * resolving them needs the terminal escape hatch, not stage/unstage.
 *
 * **Selection** is keyed by `(section, path)` rather than by path alone —
 * a partially-staged file appears as two independent rows (one in Staged,
 * one in Unstaged) and selecting one must not also select the other.
 * `stage`/`unstage` each require EXACTLY one of `paths` or `all` server
 * side (400 otherwise) — "stage all"/"unstage all" therefore send
 * `{all: true}` unconditionally rather than being synthesized from
 * "every row is selected".
 *
 * **Discard** (F84) is destructive and irreversible — `GitChangesService
 * .discard` partitions the given paths into tracked (reverted to HEAD via
 * `restore --staged --worktree`) and untracked (deleted via `clean -fd`),
 * so a selection mixing both kinds genuinely works, but the dialog body
 * says concretely what will happen to make that irreversibility legible
 * before it happens. It routes through `ConfirmDialogService` and only
 * calls the API once that resolves `true`, with the exact `'discard'`
 * literal (`DISCARD_CONFIRM_TEXT`, mirrored from the server, F89).
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
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly repo = input.required<string>();

  protected readonly status = signal<LoadStatus>('idle');
  protected readonly entries = signal<GitStatusEntry[]>([]);
  protected readonly error = signal<ApiError | null>(null);

  protected readonly selectedKeys = signal<ReadonlySet<string>>(new Set());

  protected readonly actionBusy = signal(false);
  protected readonly actionError = signal<ApiError | null>(null);

  protected readonly commitMessage = signal('');
  protected readonly amend = signal(false);
  protected readonly signoff = signal(false);
  protected readonly commitError = signal<ApiError | null>(null);

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

  /** Paths selected in the Staged section — candidates for "unstage selected". */
  protected readonly selectedStagedPaths = computed(() =>
    this.staged()
      .filter((e) => this.isSelected('staged', e.path))
      .map((e) => e.path),
  );

  /** Paths selected in Unstaged + Untracked — candidates for "stage selected". */
  protected readonly selectedUnstagedPaths = computed(() =>
    distinct([
      ...this.unstaged()
        .filter((e) => this.isSelected('unstaged', e.path))
        .map((e) => e.path),
      ...this.untracked()
        .filter((e) => this.isSelected('untracked', e.path))
        .map((e) => e.path),
    ]),
  );

  /** Every selected path, deduplicated — discard doesn't care which section a path was selected from. */
  protected readonly selectedAnyPaths = computed(() =>
    distinct([...this.selectedStagedPaths(), ...this.selectedUnstagedPaths()]),
  );

  protected readonly canCommit = computed(
    () => this.commitMessage().trim().length > 0 && !this.actionBusy(),
  );

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

  protected isSelected(section: SelectionSection, path: string): boolean {
    return this.selectedKeys().has(selectionKey(section, path));
  }

  protected toggleSelected(section: SelectionSection, path: string): void {
    const key = selectionKey(section, path);
    const next = new Set(this.selectedKeys());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.selectedKeys.set(next);
  }

  protected onMessageInput(event: Event): void {
    this.commitMessage.set((event.target as HTMLTextAreaElement).value);
  }

  protected onAmendChange(event: Event): void {
    this.amend.set((event.target as HTMLInputElement).checked);
  }

  protected onSignoffChange(event: Event): void {
    this.signoff.set((event.target as HTMLInputElement).checked);
  }

  protected async stageAll(): Promise<void> {
    await this.runAction(() => this.api.gitStage(this.repo(), { all: true }));
  }

  protected async stageSelected(): Promise<void> {
    const paths = this.selectedUnstagedPaths();
    if (paths.length === 0) {
      return;
    }
    await this.runAction(() => this.api.gitStage(this.repo(), { paths }));
  }

  protected async unstageAll(): Promise<void> {
    await this.runAction(() => this.api.gitUnstage(this.repo(), { all: true }));
  }

  protected async unstageSelected(): Promise<void> {
    const paths = this.selectedStagedPaths();
    if (paths.length === 0) {
      return;
    }
    await this.runAction(() => this.api.gitUnstage(this.repo(), { paths }));
  }

  protected async discardSelected(): Promise<void> {
    const paths = this.selectedAnyPaths();
    if (paths.length === 0) {
      return;
    }
    const confirmed = await this.confirmDialog.open({
      title: 'Discard selected changes?',
      body: this.describeDiscard(paths),
      requiredText: DISCARD_CONFIRM_TEXT,
    });
    if (!confirmed) {
      return;
    }
    await this.runAction(() => this.api.gitDiscard(this.repo(), paths));
  }

  protected async submitCommit(): Promise<void> {
    if (!this.canCommit()) {
      return;
    }
    this.commitError.set(null);
    this.actionBusy.set(true);
    try {
      await firstValueFrom(
        this.api.gitCommit(this.repo(), {
          message: this.commitMessage(),
          amend: this.amend(),
          signoff: this.signoff(),
        }),
      );
      this.commitMessage.set('');
      this.amend.set(false);
      this.signoff.set(false);
      await this.load(this.repo());
    } catch (err) {
      this.commitError.set(err as ApiError);
    } finally {
      this.actionBusy.set(false);
    }
  }

  /** Concretely states what discarding this exact selection will do (F84) —
   * a mixed selection is the ordinary case, not an edge case, per
   * `GitChangesService.discard`'s own doc comment. */
  private describeDiscard(paths: string[]): string {
    const byPath = new Map(this.entries().map((e) => [e.path, e]));
    let trackedCount = 0;
    let untrackedCount = 0;
    for (const path of paths) {
      if (byPath.get(path)?.kind === 'untracked') {
        untrackedCount++;
      } else {
        trackedCount++;
      }
    }
    const actions: string[] = [];
    if (trackedCount > 0) {
      actions.push(
        `revert ${trackedCount} tracked file${trackedCount === 1 ? '' : 's'} to HEAD, discarding both staged and unstaged changes`,
      );
    }
    if (untrackedCount > 0) {
      actions.push(
        `permanently delete ${untrackedCount} untracked file${untrackedCount === 1 ? '' : 's'}`,
      );
    }
    return `This will ${actions.join(' and ')}. This cannot be undone.`;
  }

  private async runAction(action: () => Observable<unknown>): Promise<void> {
    this.actionBusy.set(true);
    this.actionError.set(null);
    try {
      await firstValueFrom(action());
      this.selectedKeys.set(new Set());
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
      const result = await firstValueFrom(this.api.gitStatus(repo));
      this.entries.set(result.entries);
      this.status.set('loaded');
    } catch (err) {
      this.error.set(err as ApiError);
      this.status.set('error');
    }
  }
}
