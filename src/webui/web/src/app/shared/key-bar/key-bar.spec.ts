import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KeyBar, ctrlCode } from './key-bar';

describe('ctrlCode', () => {
  it('computes the canonical Ctrl+letter control codes, case-insensitively', () => {
    expect(ctrlCode('c')).toBe('\x03');
    expect(ctrlCode('C')).toBe('\x03');
    expect(ctrlCode('d')).toBe('\x04');
    expect(ctrlCode('[')).toBe('\x1b');
  });
});

describe('KeyBar', () => {
  async function create(): Promise<ComponentFixture<KeyBar>> {
    await TestBed.configureTestingModule({
      imports: [KeyBar],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyBar);
    fixture.detectChanges();
    return fixture;
  }

  function click(root: HTMLElement, ariaLabel: string): void {
    const button = Array.from(root.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === ariaLabel,
    );
    if (!button) {
      throw new Error(`No button with aria-label "${ariaLabel}"`);
    }
    (button as HTMLButtonElement).click();
  }

  function ctrlButton(root: HTMLElement): HTMLButtonElement {
    return root.querySelector('.key.ctrl') as HTMLButtonElement;
  }

  it('emits the exact byte sequence for every key, unmodified', async () => {
    const fixture = await create();
    const emitted: string[] = [];
    fixture.componentInstance.keyPress.subscribe((s) => emitted.push(s));
    const root = fixture.nativeElement as HTMLElement;

    click(root, 'Escape');
    click(root, 'Tab');
    click(root, 'Up arrow');
    click(root, 'Down arrow');
    click(root, 'Left arrow');
    click(root, 'Right arrow');
    click(root, 'Pipe');
    click(root, 'Slash');
    click(root, 'Dash');
    click(root, 'Tilde');
    click(root, 'Page up');
    click(root, 'Page down');

    expect(emitted).toEqual([
      '\x1b',
      '\t',
      '\x1b[A',
      '\x1b[B',
      '\x1b[D',
      '\x1b[C',
      '|',
      '/',
      '-',
      '~',
      '\x1b[5~',
      '\x1b[6~',
    ]);
  });

  it('sticky Ctrl composes with the next single-character keypress, then disarms', async () => {
    const fixture = await create();
    const emitted: string[] = [];
    fixture.componentInstance.keyPress.subscribe((s) => emitted.push(s));
    const root = fixture.nativeElement as HTMLElement;

    ctrlButton(root).click();
    click(root, 'Slash'); // '/' = 0x2F & 0x1F
    expect(emitted).toEqual([ctrlCode('/')]);

    // One-shot: disarmed after composing once, so the next tap is plain.
    click(root, 'Slash');
    expect(emitted).toEqual([ctrlCode('/'), '/']);
  });

  it('does not transform multi-byte escape sequences, but still consumes the armed Ctrl', async () => {
    const fixture = await create();
    const emitted: string[] = [];
    fixture.componentInstance.keyPress.subscribe((s) => emitted.push(s));
    const root = fixture.nativeElement as HTMLElement;

    ctrlButton(root).click();
    click(root, 'Up arrow');
    expect(emitted).toEqual(['\x1b[A']);

    // Consumed by the arrow tap — a further tap is not still composed.
    click(root, 'Tab');
    expect(emitted).toEqual(['\x1b[A', '\t']);
  });

  it('tapping Ctrl alone sends nothing, and tapping it twice disarms without effect', async () => {
    const fixture = await create();
    const emitted: string[] = [];
    fixture.componentInstance.keyPress.subscribe((s) => emitted.push(s));
    const root = fixture.nativeElement as HTMLElement;

    ctrlButton(root).click();
    ctrlButton(root).click();
    expect(emitted).toEqual([]);

    click(root, 'Slash');
    expect(emitted).toEqual(['/']);
  });

  it('reflects the armed state visually via aria-pressed and a CSS class', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    const btn = ctrlButton(root);

    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.classList.contains('armed')).toBe(false);

    btn.click();
    fixture.detectChanges();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('armed')).toBe(true);
  });
});
