import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Hunk } from '../../core/diff-parser';
import { HunkList } from './hunk-list';

const HUNKS: Hunk[] = [
  {
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { type: 'context', text: 'unchanged' },
      { type: 'del', text: 'old line' },
      { type: 'add', text: 'new line' },
    ],
  },
];

describe('HunkList', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HunkList],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  function create(hunks: Hunk[]) {
    const fixture = TestBed.createComponent(HunkList);
    fixture.componentRef.setInput('hunks', hunks);
    return fixture;
  }

  it('renders a "no differences" message for an empty hunk list', async () => {
    const fixture = create([]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.no-diff')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.hunk')).toBeNull();
  });

  it('renders the hunk header and lines with add/del/context classes', async () => {
    const fixture = create(HUNKS);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.hunk').length).toBe(1);
    expect(root.querySelector('.hunk-text')?.textContent).toContain('@@ -1,2 +1,2 @@');

    const lines = root.querySelectorAll('.line');
    expect(lines.length).toBe(3);
    expect(lines[1].classList.contains('del')).toBe(true);
    expect(lines[2].classList.contains('add')).toBe(true);
  });

  it('collapsing a hunk hides its lines; expanding shows them again', async () => {
    const fixture = create(HUNKS);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const headerBtn = root.querySelector('.hunk-header') as HTMLButtonElement;
    headerBtn.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.line').length).toBe(0);
    expect(headerBtn.getAttribute('aria-expanded')).toBe('false');

    headerBtn.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.line').length).toBe(3);
  });

  it('resets collapse state when the hunks input changes', async () => {
    const fixture = create(HUNKS);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('.hunk-header') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.line').length).toBe(0);

    fixture.componentRef.setInput('hunks', [
      { header: '@@ -1 +1 @@', lines: [{ type: 'context', text: 'x' }] },
    ]);
    await fixture.whenStable();
    expect(root.querySelectorAll('.line').length).toBe(1);
  });
});
