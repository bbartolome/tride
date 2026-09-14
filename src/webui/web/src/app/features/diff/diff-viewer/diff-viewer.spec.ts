import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { DiffResponse } from '../../../core/api.types';
import { DiffViewer } from './diff-viewer';

const TEXT_DIFF = [
  'diff --git a/foo.txt b/foo.txt',
  'index abc..def 100644',
  '--- a/foo.txt',
  '+++ b/foo.txt',
  '@@ -1,2 +1,2 @@',
  ' unchanged',
  '-old line',
  '+new line',
].join('\n');

describe('DiffViewer', () => {
  let gitDiff: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    gitDiff = vi.fn().mockReturnValue(of({ text: TEXT_DIFF } satisfies DiffResponse));
    await TestBed.configureTestingModule({
      imports: [DiffViewer],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiClient, useValue: { gitDiff } as unknown as ApiClient },
      ],
    }).compileComponents();
  });

  function create(opts: { repo?: string; file?: string; staged?: string } = {}) {
    const fixture = TestBed.createComponent(DiffViewer);
    fixture.componentRef.setInput('repo', opts.repo ?? 'my-repo');
    if (opts.file !== undefined) {
      fixture.componentRef.setInput('file', opts.file);
    } else {
      fixture.componentRef.setInput('file', 'foo.txt');
    }
    if (opts.staged !== undefined) {
      fixture.componentRef.setInput('staged', opts.staged);
    }
    return fixture;
  }

  it('calls gitDiff with the repo, path, staged (parsed from the query-param string) and a default context', async () => {
    const fixture = create({ repo: 'my-repo', file: 'foo.txt', staged: 'true' });
    await fixture.whenStable();
    expect(gitDiff).toHaveBeenCalledWith('my-repo', {
      path: 'foo.txt',
      staged: true,
      context: 3,
    });
  });

  it('treats a missing/"false" staged query param as unstaged', async () => {
    const fixture = create({ repo: 'my-repo', file: 'foo.txt' });
    await fixture.whenStable();
    expect(gitDiff).toHaveBeenCalledWith('my-repo', {
      path: 'foo.txt',
      staged: false,
      context: 3,
    });
  });

  it('renders the parsed hunk header and lines with add/del/context classes', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.hunk').length).toBe(1);
    expect(root.querySelector('.hunk-text')?.textContent).toContain('@@ -1,2 +1,2 @@');

    const lines = root.querySelectorAll('.line');
    expect(lines.length).toBe(3);
    expect(lines[0].classList.contains('add')).toBe(false);
    expect(lines[0].classList.contains('del')).toBe(false);
    expect(lines[1].classList.contains('del')).toBe(true);
    expect(lines[2].classList.contains('add')).toBe(true);
  });

  it('collapsing a hunk hides its lines; expanding shows them again', async () => {
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.line').length).toBe(3);

    const headerBtn = root.querySelector('.hunk-header') as HTMLButtonElement;
    headerBtn.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.line').length).toBe(0);
    expect(headerBtn.getAttribute('aria-expanded')).toBe('false');

    headerBtn.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.line').length).toBe(3);
    expect(headerBtn.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows a binary-file state instead of attempting to parse, for {binary: true}', async () => {
    gitDiff.mockReturnValue(of({ binary: true } satisfies DiffResponse));
    const fixture = create();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.hunk')).toBeNull();
    expect(root.querySelector('app-empty-state .message')?.textContent).toContain(
      'Binary file',
    );
  });

  it('shows an empty state with the server message on error', async () => {
    gitDiff.mockReturnValue(
      throwError(() => ({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' })),
    );
    const fixture = create();
    await fixture.whenStable();
    const message = fixture.nativeElement.querySelector('app-empty-state .message');
    expect(message?.textContent).toContain('boom');
  });

  it('shows the staged/unstaged badge based on the staged query param', async () => {
    const fixture = create({ staged: 'true' });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.badge.staged')).toBeTruthy();

    const fixture2 = create({ staged: 'false' });
    await fixture2.whenStable();
    expect(fixture2.nativeElement.querySelector('.badge.unstaged')).toBeTruthy();
  });
});
