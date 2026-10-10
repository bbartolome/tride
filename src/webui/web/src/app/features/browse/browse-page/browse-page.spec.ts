import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { TreeEntry, TreeResponse, TerminalSummary } from '../../../core/api.types';
import { BrowsePage } from './browse-page';

const ENTRIES: TreeEntry[] = [
  { name: 'zeta-repo', type: 'dir', isRepo: true },
  { name: 'alpha-dir', type: 'dir' },
  { name: 'readme.md', type: 'file', size: 42 },
  { name: 'notes', type: 'file' },
];

function treeFor(path: string): TreeResponse {
  return { path, entries: ENTRIES };
}

describe('BrowsePage', () => {
  let fsTree: ReturnType<typeof vi.fn>;
  let createTerminal: ReturnType<typeof vi.fn>;
  let navigateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fsTree = vi.fn().mockImplementation((path: string) => of(treeFor(path)));
    createTerminal = vi.fn().mockReturnValue(
      of({
        id: 'term-1',
        cwd: 'a/b',
        mode: 'shell',
        label: '',
        createdAt: 0,
      } satisfies TerminalSummary),
    );

    await TestBed.configureTestingModule({
      imports: [BrowsePage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ApiClient,
          useValue: { fsTree, createTerminal } as unknown as ApiClient,
        },
      ],
    }).compileComponents();

    navigateSpy = vi.spyOn(TestBed.inject(Router), 'navigate');
  });

  function createAt(path: string) {
    const fixture = TestBed.createComponent(BrowsePage);
    fixture.componentRef.setInput('path', path);
    return fixture;
  }

  it('loads the tree for the bound path', async () => {
    const fixture = createAt('a/b');
    await fixture.whenStable();
    expect(fsTree).toHaveBeenCalledWith('a/b');
  });

  it('renders directories before files, in the order the API returns them within each group', async () => {
    const fixture = createAt('a/b');
    await fixture.whenStable();

    const rows = fixture.nativeElement.querySelectorAll('.entry .name');
    const names = Array.from(rows).map((el) => (el as HTMLElement).textContent);
    // alpha-dir/zeta-repo (dirs, alphabetical) before notes/readme.md (files, alphabetical).
    expect(names).toEqual(['alpha-dir', 'zeta-repo', 'notes', 'readme.md']);
  });

  it('badges only the isRepo directory and links it to /browse/<path> with an Open as repo link', async () => {
    const fixture = createAt('a/b');
    await fixture.whenStable();

    const badges = fixture.nativeElement.querySelectorAll('.badge.repo');
    expect(badges.length).toBe(1);

    const repoRow = badges[0].closest('.entry-main') as HTMLAnchorElement;
    expect(repoRow.getAttribute('href')).toBe('/browse/a/b/zeta-repo');

    const openRepo = fixture.nativeElement.querySelector(
      '.open-repo',
    ) as HTMLAnchorElement;
    expect(openRepo.getAttribute('href')).toBe('/repo/a/b/zeta-repo');

    const plainDirRow = fixture.nativeElement.querySelector(
      '.entry-main[href="/browse/a/b/alpha-dir"]',
    );
    expect(plainDirRow).toBeTruthy();
  });

  it('opens a terminal at the directory itself for a directory row', async () => {
    const fixture = createAt('a/b');
    await fixture.whenStable();

    const dirRow = fixture.nativeElement.querySelector(
      '.entry-main[href="/browse/a/b/alpha-dir"]',
    ) as HTMLElement;
    const button = dirRow.closest('.entry')!.querySelector(
      'button.terminal-action',
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();

    expect(createTerminal).toHaveBeenCalledWith('a/b/alpha-dir', { mode: 'shell' });
    expect(navigateSpy).toHaveBeenCalledWith(['/terminal', 'term-1']);
  });

  it('opens a terminal at the containing directory for a file row', async () => {
    const fixture = createAt('a/b');
    await fixture.whenStable();

    const rootEl = fixture.nativeElement as HTMLElement;
    const fileRow = Array.from(
      rootEl.querySelectorAll<HTMLElement>('.entry'),
    ).find((row) => row.textContent?.includes('readme.md'))!;
    const button = fileRow.querySelector('button.terminal-action') as HTMLButtonElement;
    button.click();
    await fixture.whenStable();

    expect(createTerminal).toHaveBeenCalledWith('a/b', { mode: 'shell' });
  });

  it('renders a breadcrumb and an up-one-level control built from the path segments', async () => {
    const fixture = createAt('a/b');
    await fixture.whenStable();

    const crumbs = fixture.nativeElement.querySelectorAll('.crumb');
    const crumbLabels = Array.from(crumbs).map((el) => (el as HTMLElement).textContent);
    expect(crumbLabels).toEqual(['workspace', 'a', 'b']);

    const up = fixture.nativeElement.querySelector('a.up') as HTMLAnchorElement;
    expect(up.getAttribute('href')).toBe('/browse/a');
  });

  it('has no up-one-level control at the workspace root', async () => {
    const fixture = createAt('');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('a.up')).toBeFalsy();
  });

  it('reloads the tree when the bound path changes', async () => {
    const fixture = createAt('a');
    await fixture.whenStable();
    fsTree.mockClear();

    fixture.componentRef.setInput('path', 'a/b');
    await fixture.whenStable();

    expect(fsTree).toHaveBeenCalledWith('a/b');
  });
});
