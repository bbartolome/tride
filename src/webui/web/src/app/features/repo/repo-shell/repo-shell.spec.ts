import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { GitStatusResult, TerminalSummary } from '../../../core/api.types';
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
  let router: Router;

  beforeEach(async () => {
    gitStatus = vi.fn().mockReturnValue(of(STATUS));
    createTerminal = vi.fn().mockReturnValue(of(TERMINAL));
    await TestBed.configureTestingModule({
      imports: [RepoShell],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ApiClient,
          useValue: { gitStatus, createTerminal } as unknown as ApiClient,
        },
      ],
    }).compileComponents();
    router = TestBed.inject(Router);
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

  it('renders all four tabs, with Changes active and rendered by default', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const tabLabels = Array.from(root.querySelectorAll('.tab')).map(
      (el) => el.textContent?.trim(),
    );
    expect(tabLabels).toEqual(['Changes', 'Branches', 'Log', 'Stash']);
    expect(root.querySelector('.tab.active')?.textContent?.trim()).toBe('Changes');
    expect(root.querySelector('app-changes-tab')).toBeTruthy();
  });

  it('switching tabs shows the placeholder and hides the Changes tab content', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const buttons = Array.from(root.querySelectorAll('.tab')) as HTMLButtonElement[];
    const branchesBtn = buttons.find((b) => b.textContent?.trim() === 'Branches');
    branchesBtn?.click();
    await fixture.whenStable();

    expect(root.querySelector('app-changes-tab')).toBeNull();
    expect(root.querySelector('.tab-placeholder.branches')).toBeTruthy();
    expect(root.querySelector('.tab.active')?.textContent?.trim()).toBe('Branches');
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
});
