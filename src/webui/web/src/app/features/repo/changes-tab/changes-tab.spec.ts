import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { GitStatusEntry, GitStatusResult } from '../../../core/api.types';
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

  beforeEach(async () => {
    gitStatus = vi.fn().mockReturnValue(of(STATUS_RESULT));
    await TestBed.configureTestingModule({
      imports: [ChangesTab],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiClient, useValue: { gitStatus } as unknown as ApiClient },
      ],
    }).compileComponents();
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
});
