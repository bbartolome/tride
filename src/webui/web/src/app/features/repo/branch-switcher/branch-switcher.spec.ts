import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { BranchSwitcher } from './branch-switcher';

const LIST = {
  current: 'main',
  detached: false,
  local: [
    { name: 'main', sha: 'a', upstream: null, ahead: 0, behind: 0, upstreamGone: false },
    { name: 'dev', sha: 'b', upstream: null, ahead: 1, behind: 0, upstreamGone: false },
  ],
  remote: [],
};

describe('BranchSwitcher', () => {
  let gitBranches: ReturnType<typeof vi.fn>;
  let gitCheckout: ReturnType<typeof vi.fn>;
  let gitCreateBranch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    gitBranches = vi.fn().mockReturnValue(of(LIST));
    gitCheckout = vi.fn().mockReturnValue(of({ ok: true }));
    gitCreateBranch = vi.fn().mockReturnValue(of({ ok: true }));
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiClient,
          useValue: { gitBranches, gitCheckout, gitCreateBranch, gitDeleteBranch: vi.fn() },
        },
        { provide: ConfirmDialogService, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();
  });

  async function openPanel() {
    const fixture = TestBed.createComponent(BranchSwitcher);
    fixture.componentRef.setInput('repo', 'r');
    fixture.componentRef.setInput('current', 'main');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('.toggle') as HTMLButtonElement).click();
    await fixture.whenStable();
    return { fixture, root };
  }

  it('shows the current branch and lists local branches when opened', async () => {
    const { root } = await openPanel();
    expect(root.querySelector('.toggle .branch')?.textContent).toBe('main');
    expect(gitBranches).toHaveBeenCalledWith('r');
    const names = Array.from(root.querySelectorAll('.row .name')).map((e) => e.textContent);
    expect(names).toEqual(['main', 'dev']);
  });

  it('checks out a branch, emits changed and closes', async () => {
    const { fixture, root } = await openPanel();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    ((root.querySelectorAll('.pick')[1]) as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitCheckout).toHaveBeenCalledWith('r', { branch: 'dev' });
    expect(changed).toHaveBeenCalled();
    expect(root.querySelector('.panel')).toBeNull();
  });

  it('creates a branch from the name field', async () => {
    const { fixture, root } = await openPanel();
    const input = root.querySelector('.new-branch input') as HTMLInputElement;
    input.value = 'feat';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    (root.querySelector('.new-branch button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitCreateBranch).toHaveBeenCalledWith('r', { name: 'feat' });
  });
});
