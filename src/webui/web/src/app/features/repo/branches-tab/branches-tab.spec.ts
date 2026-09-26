import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { BranchListResult } from '../../../core/api.types';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { BranchesTab } from './branches-tab';

const BRANCHES: BranchListResult = {
  current: 'main',
  detached: false,
  local: [
    { name: 'main', sha: 'aaa', upstream: 'origin/main', ahead: 0, behind: 0, upstreamGone: false },
    { name: 'feature/x', sha: 'bbb', upstream: null, ahead: 2, behind: 1, upstreamGone: false },
  ],
  remote: [{ name: 'origin/main', sha: 'aaa' }],
};

describe('BranchesTab', () => {
  let gitBranches: ReturnType<typeof vi.fn>;
  let gitCheckout: ReturnType<typeof vi.fn>;
  let gitCreateBranch: ReturnType<typeof vi.fn>;
  let gitDeleteBranch: ReturnType<typeof vi.fn>;
  let confirmDialog: ConfirmDialogService;

  beforeEach(async () => {
    gitBranches = vi.fn().mockReturnValue(of(BRANCHES));
    gitCheckout = vi.fn().mockReturnValue(of({ ok: true }));
    gitCreateBranch = vi.fn().mockReturnValue(of({ ok: true }));
    gitDeleteBranch = vi.fn().mockReturnValue(of({ ok: true }));
    await TestBed.configureTestingModule({
      imports: [BranchesTab],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiClient,
          useValue: {
            gitBranches,
            gitCheckout,
            gitCreateBranch,
            gitDeleteBranch,
          } as unknown as ApiClient,
        },
      ],
    }).compileComponents();
    confirmDialog = TestBed.inject(ConfirmDialogService);
  });

  function create(repo = 'my-repo') {
    const fixture = TestBed.createComponent(BranchesTab);
    fixture.componentRef.setInput('repo', repo);
    return fixture;
  }

  it('calls gitBranches(repo) and renders local/remote branches', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    expect(gitBranches).toHaveBeenCalledWith('my-repo');
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.branch-section.local .branch-row').length).toBe(2);
    expect(root.querySelectorAll('.branch-section.remote .branch-row').length).toBe(1);
    expect(root.querySelector('.branch-row.current .name')?.textContent).toBe('main');
  });

  it('does not render checkout/delete actions for the current branch', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const currentRow = root.querySelector('.branch-row.current') as HTMLElement;
    expect(currentRow.querySelector('.branch-actions')).toBeNull();
  });

  it('checkout calls gitCheckout with the branch name', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const rows = Array.from(root.querySelectorAll('.branch-section.local .branch-row'));
    const featureRow = rows.find((r) => r.textContent?.includes('feature/x')) as HTMLElement;
    const checkoutBtn = Array.from(featureRow.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Checkout',
    ) as HTMLButtonElement;
    checkoutBtn.click();
    await fixture.whenStable();

    expect(gitCheckout).toHaveBeenCalledWith('my-repo', { branch: 'feature/x' });
  });

  it('create branch sends name and startPoint, and clears the form on success', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const nameInput = root.querySelector('#new-branch-name') as HTMLInputElement;
    nameInput.value = 'feature/y';
    nameInput.dispatchEvent(new Event('input'));
    const startInput = root.querySelector('#new-branch-start') as HTMLInputElement;
    startInput.value = 'origin/main';
    startInput.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    (root.querySelector('.new-branch button') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(gitCreateBranch).toHaveBeenCalledWith('my-repo', {
      name: 'feature/y',
      startPoint: 'origin/main',
    });
    expect((root.querySelector('#new-branch-name') as HTMLInputElement).value).toBe('');
  });

  it('plain delete calls gitDeleteBranch without force', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const rows = Array.from(root.querySelectorAll('.branch-section.local .branch-row'));
    const featureRow = rows.find((r) => r.textContent?.includes('feature/x')) as HTMLElement;
    const deleteBtn = Array.from(featureRow.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Delete',
    ) as HTMLButtonElement;
    deleteBtn.click();
    await fixture.whenStable();

    expect(gitDeleteBranch).toHaveBeenCalledWith('my-repo', { name: 'feature/x' });
  });

  it('force delete routes through a client-side confirm dialog before calling the API', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const rows = Array.from(root.querySelectorAll('.branch-section.local .branch-row'));
    const featureRow = rows.find((r) => r.textContent?.includes('feature/x')) as HTMLElement;
    const forceBtn = Array.from(featureRow.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Force delete',
    ) as HTMLButtonElement;
    forceBtn.click();
    await fixture.whenStable();

    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(confirmDialog.request()).toBeTruthy();

    confirmDialog.setInput(confirmDialog.request()!.requiredText);
    confirmDialog.confirm();
    await fixture.whenStable();

    expect(gitDeleteBranch).toHaveBeenCalledWith('my-repo', { name: 'feature/x', force: true });
  });

  it('shows an empty state instead of the list when there are no local branches', async () => {
    gitBranches.mockReturnValue(
      of({ current: null, detached: false, local: [], remote: [] }),
    );
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.branch-section.local app-empty-state .message')?.textContent).toBe(
      'No branches.',
    );
    expect(root.querySelector('.branch-section.local .branch-list')).toBeNull();
  });

  it('shows a detached HEAD banner when detached', async () => {
    gitBranches.mockReturnValue(
      of({ ...BRANCHES, current: null, detached: true, detachedAt: 'abc1234' }),
    );
    const fixture = create();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.detached-banner')?.textContent).toContain(
      'abc1234',
    );
  });
});
