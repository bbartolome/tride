import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { GitStatusEntry, GitStatusResult } from '../../../core/api.types';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ChangesTab } from './changes-tab';

// One entry of each `kind`, including a partially-staged-looking pair (an
// ordinary staged-only entry and an ordinary unstaged-only entry) plus a
// renamed entry, so the four-section grouping (Staged / Unstaged /
// Untracked / Conflicts) and the "show both paths" rename requirement are
// both exercised in one fixture.
const ENTRIES: GitStatusEntry[] = [
  { kind: 'ordinary', path: 'staged-only.txt', staged: true, unstaged: false },
  { kind: 'ordinary', path: 'unstaged-only.txt', staged: false, unstaged: true },
  {
    kind: 'renamed',
    path: 'new-name.txt',
    origPath: 'old-name.txt',
    staged: true,
    unstaged: false,
    score: 90,
  },
  { kind: 'unmerged', path: 'conflicted.txt', staged: false, unstaged: true },
  { kind: 'untracked', path: 'scratch.txt', isDirectory: false },
];

const STATUS_RESULT: GitStatusResult = {
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  entries: ENTRIES,
};

describe('ChangesTab', () => {
  let gitStatus: ReturnType<typeof vi.fn>;
  let gitStage: ReturnType<typeof vi.fn>;
  let gitUnstage: ReturnType<typeof vi.fn>;
  let gitDiscard: ReturnType<typeof vi.fn>;
  let gitCommit: ReturnType<typeof vi.fn>;
  let confirmDialog: ConfirmDialogService;

  beforeEach(async () => {
    gitStatus = vi.fn().mockReturnValue(of(STATUS_RESULT));
    gitStage = vi.fn().mockReturnValue(of({ ok: true }));
    gitUnstage = vi.fn().mockReturnValue(of({ ok: true }));
    gitDiscard = vi.fn().mockReturnValue(of({ ok: true }));
    gitCommit = vi.fn().mockReturnValue(of({ sha: 'deadbeef' }));
    await TestBed.configureTestingModule({
      imports: [ChangesTab],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ApiClient,
          useValue: {
            gitStatus,
            gitStage,
            gitUnstage,
            gitDiscard,
            gitCommit,
          } as unknown as ApiClient,
        },
      ],
    }).compileComponents();
    confirmDialog = TestBed.inject(ConfirmDialogService);
  });

  function create(repo = 'my-repo') {
    const fixture = TestBed.createComponent(ChangesTab);
    fixture.componentRef.setInput('repo', repo);
    return fixture;
  }

  it('calls gitStatus(repo) on init', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    expect(gitStatus).toHaveBeenCalledWith('my-repo');
  });

  it('groups entries into exactly the right four sections', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const stagedRows = root.querySelectorAll('.change-section.staged .entry-row');
    const unstagedRows = root.querySelectorAll('.change-section.unstaged .entry-row');
    const untrackedRows = root.querySelectorAll('.change-section.untracked .entry-row');
    const conflictRows = root.querySelectorAll('.change-section.conflicts .entry-row');

    // Staged: staged-only.txt + the renamed entry (also staged).
    expect(stagedRows.length).toBe(2);
    // Unstaged: unstaged-only.txt only — the unmerged entry belongs to
    // Conflicts, not Unstaged, even though its `unstaged` flag is true.
    expect(unstagedRows.length).toBe(1);
    expect(untrackedRows.length).toBe(1);
    expect(conflictRows.length).toBe(1);
  });

  it('shows both paths for a renamed entry', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const renamedRow = Array.from(
      root.querySelectorAll('.change-section.staged .entry-row'),
    ).find((row) => row.textContent?.includes('new-name.txt'));

    expect(renamedRow).toBeTruthy();
    expect(renamedRow?.querySelector('.orig-path')?.textContent).toBe('old-name.txt');
    expect(renamedRow?.textContent).toContain('new-name.txt');
  });

  it('links a status row to the diff route with file and staged query params', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const stagedRow = Array.from(
      root.querySelectorAll('.change-section.staged .entry-row'),
    ).find((row) => row.textContent?.includes('staged-only.txt')) as HTMLAnchorElement;

    expect(stagedRow.getAttribute('href')).toBe(
      '/repo/my-repo/diff?file=staged-only.txt&staged=true',
    );

    const unstagedRow = root.querySelector(
      '.change-section.unstaged .entry-row',
    ) as HTMLAnchorElement;
    expect(unstagedRow.getAttribute('href')).toBe(
      '/repo/my-repo/diff?file=unstaged-only.txt&staged=false',
    );
  });

  it('does not render untracked entries as links (nothing to diff yet)', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const untrackedRow = root.querySelector('.change-section.untracked .entry-row');
    expect(untrackedRow?.tagName).toBe('LI');
    expect(untrackedRow?.querySelector('a')).toBeNull();
  });

  it('shows a clean empty state when there are no entries', async () => {
    gitStatus.mockReturnValue(
      of({ ...STATUS_RESULT, entries: [] } satisfies GitStatusResult),
    );
    const fixture = create();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-empty-state')).toBeTruthy();
  });

  it('shows an empty state with the server message on error', async () => {
    gitStatus.mockReturnValue(
      throwError(() => ({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' })),
    );
    const fixture = create();
    await fixture.whenStable();
    const message = fixture.nativeElement.querySelector('app-empty-state .message');
    expect(message?.textContent).toContain('boom');
  });

  it('"Stage all" sends {all: true} and never a paths key', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const buttons = Array.from(root.querySelectorAll('.bulk-actions button'));
    const stageAllBtn = buttons.find((b) => b.textContent?.trim() === 'Stage all') as HTMLButtonElement;
    stageAllBtn.click();
    await fixture.whenStable();

    expect(gitStage).toHaveBeenCalledWith('my-repo', { all: true });
    expect(gitStage.mock.calls[0][1]).not.toHaveProperty('paths');
  });

  it('selecting an unstaged row and "Stage selected" sends exactly those paths', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const unstagedCheckbox = root.querySelector(
      '.change-section.unstaged input[type="checkbox"]',
    ) as HTMLInputElement;
    unstagedCheckbox.click();
    await fixture.whenStable();

    const buttons = Array.from(root.querySelectorAll('.bulk-actions button'));
    const stageSelectedBtn = buttons.find((b) =>
      b.textContent?.trim().startsWith('Stage selected'),
    ) as HTMLButtonElement;
    expect(stageSelectedBtn.disabled).toBe(false);
    stageSelectedBtn.click();
    await fixture.whenStable();

    expect(gitStage).toHaveBeenCalledWith('my-repo', { paths: ['unstaged-only.txt'] });
  });

  it('discard routes through the confirm dialog and only calls the API once it resolves true', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const stagedCheckbox = root.querySelector(
      '.change-section.staged input[type="checkbox"]',
    ) as HTMLInputElement;
    stagedCheckbox.click();
    await fixture.whenStable();

    const discardBtn = Array.from(root.querySelectorAll('.bulk-actions button')).find(
      (b) => b.textContent?.trim() === 'Discard selected',
    ) as HTMLButtonElement;
    discardBtn.click();
    await fixture.whenStable();

    // Not called yet — the dialog is pending confirmation.
    expect(gitDiscard).not.toHaveBeenCalled();
    expect(confirmDialog.request()).toBeTruthy();
    expect(confirmDialog.request()?.requiredText).toBe('discard');

    confirmDialog.setInput('discard');
    confirmDialog.confirm();
    await fixture.whenStable();

    expect(gitDiscard).toHaveBeenCalledWith('my-repo', ['staged-only.txt']);
  });

  it('cancelling the discard confirm dialog never calls the API', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const checkbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    await fixture.whenStable();

    const discardBtn = Array.from(root.querySelectorAll('.bulk-actions button')).find(
      (b) => b.textContent?.trim() === 'Discard selected',
    ) as HTMLButtonElement;
    discardBtn.click();
    await fixture.whenStable();

    confirmDialog.cancel();
    await fixture.whenStable();

    expect(gitDiscard).not.toHaveBeenCalled();
  });

  it('commit sends exactly the message/amend/signoff flags given, and is disabled for a blank message', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const commitBtn = root.querySelector('.commit-form button') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);

    const textarea = root.querySelector('#commit-message') as HTMLTextAreaElement;
    textarea.value = '  ';
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(commitBtn.disabled).toBe(true);

    textarea.value = 'fix the thing';
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(commitBtn.disabled).toBe(false);

    const checkboxes = root.querySelectorAll('.commit-form input[type="checkbox"]');
    (checkboxes[0] as HTMLInputElement).click(); // amend
    await fixture.whenStable();

    commitBtn.click();
    await fixture.whenStable();

    expect(gitCommit).toHaveBeenCalledWith('my-repo', {
      message: 'fix the thing',
      amend: true,
      signoff: false,
    });
  });
});
