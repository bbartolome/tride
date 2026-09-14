import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { RepoSummary } from '../../../core/api.types';
import { ReposPage } from './repos-page';

const FIXTURE: RepoSummary[] = [
  {
    path: 'dirty-repo',
    name: 'dirty-repo',
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 2,
    dirty: true,
    isWorktree: false,
  },
  {
    path: 'clean-repo',
    name: 'clean-repo',
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    dirty: false,
    isWorktree: false,
  },
  {
    path: 'nested/worktree-repo',
    name: 'worktree-repo',
    branch: 'feature',
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    isWorktree: true,
  },
  {
    path: 'detached-repo',
    name: 'detached-repo',
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    isWorktree: false,
  },
];

describe('ReposPage', () => {
  let listRepos: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    listRepos = vi.fn().mockReturnValue(of(FIXTURE));
    await TestBed.configureTestingModule({
      imports: [ReposPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiClient, useValue: { listRepos } as unknown as ApiClient },
      ],
    }).compileComponents();
  });

  it('calls listRepos() on init', () => {
    // load()'s synchronous prelude (before its first `await`) runs the
    // instant the component is constructed, so this needs no whenStable().
    TestBed.createComponent(ReposPage);
    expect(listRepos).toHaveBeenCalledWith(false);
  });

  it('renders one card per repo, with markers on exactly the right rows', async () => {
    const fixture = TestBed.createComponent(ReposPage);
    await fixture.whenStable();

    const cards = fixture.nativeElement.querySelectorAll('.repo-card');
    expect(cards.length).toBe(4);

    // dirty: only the first (dirty-repo) row.
    expect(cards[0].querySelector('.dot.dirty')).toBeTruthy();
    expect(cards[1].querySelector('.dot.dirty')).toBeFalsy();
    expect(cards[2].querySelector('.dot.dirty')).toBeFalsy();
    expect(cards[3].querySelector('.dot.dirty')).toBeFalsy();
    expect(fixture.nativeElement.querySelectorAll('.dot.dirty').length).toBe(1);
    expect(fixture.nativeElement.querySelectorAll('.dot.clean').length).toBe(3);

    // worktree: only the third (nested/worktree-repo) row.
    expect(fixture.nativeElement.querySelectorAll('.badge.worktree').length).toBe(1);
    expect(cards[2].querySelector('.badge.worktree')).toBeTruthy();

    // detached: only the fourth (detached-repo) row.
    expect(fixture.nativeElement.querySelectorAll('.badge.detached').length).toBe(1);
    expect(cards[3].querySelector('.badge.detached')).toBeTruthy();
    expect(cards[3].querySelector('.branch')).toBeFalsy();

    // path with slashes becomes /repo/<segments> route link, not /repo/nested%2Fworktree-repo.
    expect(cards[2].getAttribute('href')).toBe('/repo/nested/worktree-repo');
  });

  it('shows an empty state when the workspace has no repos', async () => {
    listRepos.mockReturnValue(of([]));
    const fixture = TestBed.createComponent(ReposPage);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-empty-state')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('.repo-card').length).toBe(0);
  });

  it('shows an empty state with the server message on error', async () => {
    listRepos.mockReturnValue(
      throwError(() => ({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' })),
    );
    const fixture = TestBed.createComponent(ReposPage);
    await fixture.whenStable();
    const message = fixture.nativeElement.querySelector('app-empty-state .message');
    expect(message?.textContent).toContain('boom');
  });

  it('refresh() calls listRepos(true), not a bare listRepos()', async () => {
    const fixture = TestBed.createComponent(ReposPage);
    await fixture.whenStable();
    listRepos.mockClear();

    const refreshBtn = fixture.nativeElement.querySelector(
      'button.refresh',
    ) as HTMLButtonElement;
    refreshBtn.click();
    await fixture.whenStable();

    expect(listRepos).toHaveBeenCalledTimes(1);
    expect(listRepos).toHaveBeenCalledWith(true);
  });
});
