import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { GitStatusResult, TerminalSummary } from '../../../core/api.types';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { RepoShell } from './repo-shell';

const STATUS: GitStatusResult = {
  branch: 'feature/x',
  detached: false,
  upstream: 'origin/feature/x',
  ahead: 2,
  behind: 1,
  entries: [],
};

const TERMINAL: TerminalSummary = {
  id: 'term-1',
  cwd: 'nested/my-repo',
  mode: 'shell',
  label: 'shell',
  createdAt: 0,
};

describe('RepoShell', () => {
  let gitStatus: ReturnType<typeof vi.fn>;
  let createTerminal: ReturnType<typeof vi.fn>;
  let gitFetch: ReturnType<typeof vi.fn>;
  let gitPull: ReturnType<typeof vi.fn>;
  let gitPush: ReturnType<typeof vi.fn>;
  let gitBranches: ReturnType<typeof vi.fn>;
  let gitLog: ReturnType<typeof vi.fn>;
  let gitStashList: ReturnType<typeof vi.fn>;
  let router: Router;
  let confirmDialog: ConfirmDialogService;

  beforeEach(async () => {
    gitStatus = vi.fn().mockReturnValue(of(STATUS));
    createTerminal = vi.fn().mockReturnValue(of(TERMINAL));
    gitFetch = vi.fn().mockReturnValue(of({ ok: true }));
    gitPull = vi.fn().mockReturnValue(of({ ok: true }));
    gitPush = vi.fn().mockReturnValue(of({ ok: true }));
    gitBranches = vi
      .fn()
      .mockReturnValue(of({ current: 'main', detached: false, local: [], remote: [] }));
    gitLog = vi.fn().mockReturnValue(of([]));
    gitStashList = vi.fn().mockReturnValue(of([]));
    await TestBed.configureTestingModule({
      imports: [RepoShell],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ApiClient,
          useValue: {
            gitStatus,
            createTerminal,
            gitFetch,
            gitPull,
            gitPush,
            gitBranches,
            gitLog,
            gitStashList,
          } as unknown as ApiClient,
        },
      ],
    }).compileComponents();
    router = TestBed.inject(Router);
    confirmDialog = TestBed.inject(ConfirmDialogService);
  });

  function create(repo = 'nested/my-repo') {
    const fixture = TestBed.createComponent(RepoShell);
    fixture.componentRef.setInput('repo', repo);
    return fixture;
  }

  it('derives the header name from the last path segment', async () => {
    const fixture = create('nested/my-repo');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toBe('my-repo');
  });

  it('shows branch and ahead/behind from gitStatus(repo)', async () => {
    const fixture = create('nested/my-repo');
    await fixture.whenStable();
    expect(gitStatus).toHaveBeenCalledWith('nested/my-repo');
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.branch')?.textContent).toBe('feature/x');
    expect(root.querySelector('.ahead')?.textContent).toContain('2');
    expect(root.querySelector('.behind')?.textContent).toContain('1');
  });

  it('renders all tabs, with Changes active and rendered by default', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const tabLabels = Array.from(root.querySelectorAll('.tab')).map(
      (el) => el.textContent?.trim(),
    );
    expect(tabLabels).toEqual(['Browse', 'Changes', 'Log', 'Stash']);
    expect(root.querySelector('.tab.active')?.textContent?.trim()).toBe('Changes');
    expect(root.querySelector('app-changes-tab')).toBeTruthy();
  });

  it('switching tabs swaps in the matching tab component', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const buttons = Array.from(root.querySelectorAll('.tab')) as HTMLButtonElement[];
    const branchesBtn = buttons.find((b) => b.textContent?.trim() === 'Stash');
    branchesBtn?.click();
    await fixture.whenStable();

    expect(root.querySelector('app-changes-tab')).toBeNull();
    expect(root.querySelector('app-stash-tab')).toBeTruthy();
    expect(root.querySelector('.tab.active')?.textContent?.trim()).toBe('Stash');

    const logBtn = buttons.find((b) => b.textContent?.trim() === 'Log');
    logBtn?.click();
    await fixture.whenStable();
    expect(root.querySelector('app-log-tab')).toBeTruthy();
    expect(gitLog).toHaveBeenCalled();

    const stashBtn = buttons.find((b) => b.textContent?.trim() === 'Stash');
    stashBtn?.click();
    await fixture.whenStable();
    expect(root.querySelector('app-stash-tab')).toBeTruthy();
    expect(gitStashList).toHaveBeenCalledWith('nested/my-repo');
  });

  it('"Open terminal here" creates a shell terminal at the repo root and navigates to it', async () => {
    const fixture = create('nested/my-repo');
    await fixture.whenStable();
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const btn = fixture.nativeElement.querySelector(
      'button.terminal-here',
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();

    expect(createTerminal).toHaveBeenCalledWith('nested/my-repo', { mode: 'shell' });
    expect(navigateSpy).toHaveBeenCalledWith(['/terminal', 'term-1']);
  });

  it('Fetch/Pull/Push call the matching ApiClient method with the repo', async () => {
    const fixture = create('nested/my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(root.querySelectorAll('.remote-toolbar button'));

    (buttons.find((b) => b.textContent?.trim() === 'Fetch') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitFetch).toHaveBeenCalledWith('nested/my-repo');

    (buttons.find((b) => b.textContent?.trim() === 'Pull') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitPull).toHaveBeenCalledWith('nested/my-repo');

    (buttons.find((b) => b.textContent?.trim() === 'Push') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitPush).toHaveBeenCalledWith('nested/my-repo');
  });

  it('Force push routes through the typed confirm dialog and sends the exact literal', async () => {
    const fixture = create('nested/my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('.remote-toolbar .danger') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(gitPush).not.toHaveBeenCalled();
    expect(confirmDialog.request()?.requiredText).toBe('force push');

    confirmDialog.setInput('force push');
    confirmDialog.confirm();
    await fixture.whenStable();

    expect(gitPush).toHaveBeenCalledWith('nested/my-repo', {
      force: true,
      confirm: 'force push',
    });
  });

  it('a 502 GIT_AUTH_REQUIRED push failure renders the terminal-escape-hatch state, not the generic error banner', async () => {
    gitPush.mockReturnValue(
      throwError(() => ({
        status: 502,
        code: 'GIT_AUTH_REQUIRED',
        message: 'Git remote authentication failed',
      })),
    );
    const fixture = create('nested/my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const pushBtn = Array.from(root.querySelectorAll('.remote-toolbar button')).find(
      (b) => b.textContent?.trim() === 'Push',
    ) as HTMLButtonElement;
    pushBtn.click();
    await fixture.whenStable();

    expect(root.querySelector('.auth-required')).toBeTruthy();
    expect(root.querySelector('.remote-error')).toBeNull();
    const terminalBtn = root.querySelector('.auth-required .open-terminal');
    expect(terminalBtn).toBeTruthy();
    expect(terminalBtn?.textContent).toContain('Open a terminal in this repo');
  });

  it('a generic (non-auth) remote error renders the plain error banner, not the escape hatch', async () => {
    gitPull.mockReturnValue(
      throwError(() => ({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' })),
    );
    const fixture = create('nested/my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const pullBtn = Array.from(root.querySelectorAll('.remote-toolbar button')).find(
      (b) => b.textContent?.trim() === 'Pull',
    ) as HTMLButtonElement;
    pullBtn.click();
    await fixture.whenStable();

    expect(root.querySelector('.auth-required')).toBeNull();
    expect(root.querySelector('.remote-error')?.textContent).toContain('boom');
  });
});
