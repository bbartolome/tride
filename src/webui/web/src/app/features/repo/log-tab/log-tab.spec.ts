import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { GitLogEntry, GitShowResult } from '../../../core/api.types';
import { LogTab } from './log-tab';

function makePage(count: number, startAt: number): GitLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    sha: `sha${startAt + i}`.padEnd(40, '0'),
    author: 'Ada',
    email: 'ada@example.com',
    date: '2024-01-01T00:00:00Z',
    message: `commit ${startAt + i}\n\nbody text`,
  }));
}

describe('LogTab', () => {
  let gitLog: ReturnType<typeof vi.fn>;
  let gitShow: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    gitLog = vi.fn().mockReturnValue(of(makePage(30, 0)));
    gitShow = vi.fn().mockReturnValue(
      of({
        header: {
          sha: 'sha0'.padEnd(40, '0'),
          author: 'Ada',
          email: 'ada@example.com',
          date: '2024-01-01T00:00:00Z',
          message: 'commit 0',
        },
        diffText: [
          'diff --git a/f.txt b/f.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n'),
      } satisfies GitShowResult),
    );
    await TestBed.configureTestingModule({
      imports: [LogTab],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { gitLog, gitShow } as unknown as ApiClient },
      ],
    }).compileComponents();
  });

  function create(repo = 'my-repo') {
    const fixture = TestBed.createComponent(LogTab);
    fixture.componentRef.setInput('repo', repo);
    return fixture;
  }

  it('loads the first page with skip 0 and the page-size limit', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    expect(gitLog).toHaveBeenCalledWith('my-repo', { limit: 30, skip: 0 });
    expect(fixture.nativeElement.querySelectorAll('.commit-row').length).toBe(30);
  });

  it('"Load more" bumps skip by exactly the page size on each successive call', async () => {
    gitLog
      .mockReturnValueOnce(of(makePage(30, 0)))
      .mockReturnValueOnce(of(makePage(30, 30)))
      .mockReturnValueOnce(of(makePage(5, 60)));
    const fixture = create('my-repo');
    await fixture.whenStable();

    const loadMoreBtn = () =>
      fixture.nativeElement.querySelector('.load-more') as HTMLButtonElement;

    loadMoreBtn().click();
    await fixture.whenStable();
    expect(gitLog).toHaveBeenNthCalledWith(2, 'my-repo', { limit: 30, skip: 30 });
    expect(fixture.nativeElement.querySelectorAll('.commit-row').length).toBe(60);

    loadMoreBtn().click();
    await fixture.whenStable();
    expect(gitLog).toHaveBeenNthCalledWith(3, 'my-repo', { limit: 30, skip: 60 });
    expect(fixture.nativeElement.querySelectorAll('.commit-row').length).toBe(65);

    // Short page (< page size) means there is nothing further to load.
    expect(fixture.nativeElement.querySelector('.load-more')).toBeNull();
  });

  it('tapping a commit calls getShow and renders diffText through the shared hunk renderer', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('.commit-row') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(gitShow).toHaveBeenCalledWith('my-repo', 'sha0'.padEnd(40, '0'));
    expect(root.querySelector('.commit-message')?.textContent).toBe('commit 0');
    expect(root.querySelectorAll('.hunk').length).toBe(1);
    const lines = root.querySelectorAll('.line');
    expect(lines.length).toBe(2);
    expect(lines[0].classList.contains('del')).toBe(true);
    expect(lines[1].classList.contains('add')).toBe(true);
  });

  it('"Back to log" returns from the commit detail to the list', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('.commit-row') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(root.querySelector('.commit-header')).toBeTruthy();

    (root.querySelector('.back') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(root.querySelector('.commit-header')).toBeNull();
    expect(root.querySelectorAll('.commit-row').length).toBe(30);
  });

  it('shows an empty state with the server message on a log-load error', async () => {
    gitLog.mockReturnValue(
      throwError(() => ({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' })),
    );
    const fixture = create();
    await fixture.whenStable();
    const message = fixture.nativeElement.querySelector('app-empty-state .message');
    expect(message?.textContent).toContain('boom');
  });
});
