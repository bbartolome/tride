import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';

interface KeyDef {
  id: string;
  label: string;
  ariaLabel: string;
  /** The exact bytes this key sends when pressed unmodified. */
  sequence: string;
}

/**
 * The fixed key set an iOS on-screen keyboard has no equivalent for and a
 * terminal is unusable without: Esc, Tab, the four arrows, the four
 * punctuation characters that are awkward to reach on a phone keyboard
 * layout (`|` `/` `-` `~`), and PgUp/PgDn. Sequences are the standard
 * VT100/xterm control sequences.
 */
const KEYS: readonly KeyDef[] = [
  { id: 'esc', label: 'Esc', ariaLabel: 'Escape', sequence: '\x1b' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab', sequence: '\t' },
  { id: 'up', label: '↑', ariaLabel: 'Up arrow', sequence: '\x1b[A' },
  { id: 'down', label: '↓', ariaLabel: 'Down arrow', sequence: '\x1b[B' },
  { id: 'left', label: '←', ariaLabel: 'Left arrow', sequence: '\x1b[D' },
  { id: 'right', label: '→', ariaLabel: 'Right arrow', sequence: '\x1b[C' },
  { id: 'pipe', label: '|', ariaLabel: 'Pipe', sequence: '|' },
  { id: 'slash', label: '/', ariaLabel: 'Slash', sequence: '/' },
  { id: 'dash', label: '-', ariaLabel: 'Dash', sequence: '-' },
  { id: 'tilde', label: '~', ariaLabel: 'Tilde', sequence: '~' },
  { id: 'pgup', label: 'PgUp', ariaLabel: 'Page up', sequence: '\x1b[5~' },
  { id: 'pgdn', label: 'PgDn', ariaLabel: 'Page down', sequence: '\x1b[6~' },
];

/**
 * The universal terminal Ctrl-code formula — masking off everything but
 * the low 5 bits. This is case-insensitive by construction (bit 5, the
 * one that distinguishes 'c' from 'C', is outside the mask), which is why
 * `ctrlCode('c') === ctrlCode('C') === '\x03'`, matching every real
 * terminal's Ctrl+<letter> behavior. Only meaningful for a single
 * character — a multi-byte escape sequence (an arrow, PgUp/PgDn) has no
 * such transform and is left untouched by `pressKey` below.
 */
export function ctrlCode(ch: string): string {
  return String.fromCharCode(ch.charCodeAt(0) & 0x1f);
}

/**
 * Mobile key bar for the terminal view — the escape hatch for every key an
 * iOS on-screen keyboard doesn't have. Every tap ends up calling
 * `keyPress.emit(...)`, which `terminal-view` wires to the exact same
 * `TerminalSocket.sendInput()` call real xterm keystrokes use — a key-bar
 * tap is never a second, independent send path to the server.
 *
 * Sticky Ctrl: tapping "Ctrl" arms it (no bytes sent — a lone Ctrl key
 * press sends nothing on a real keyboard either) and highlights the
 * button; the next key tap composes with it (`Ctrl+C` -> `\x03`) and
 * disarms it, one-shot. Composition only applies to single-character keys
 * (Esc, Tab, the four punctuation keys) — arrows and PgUp/PgDn are
 * multi-byte escape sequences with no such transform, so Ctrl is simply
 * consumed and the sequence is sent unmodified.
 */
@Component({
  selector: 'app-key-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './key-bar.html',
  styleUrl: './key-bar.scss',
})
export class KeyBar {
  protected readonly keys = KEYS;
  protected readonly ctrlArmed = signal(false);

  readonly keyPress = output<string>();

  protected toggleCtrl(): void {
    this.ctrlArmed.set(!this.ctrlArmed());
  }

  protected pressKey(key: KeyDef): void {
    const armed = this.ctrlArmed();
    this.ctrlArmed.set(false);
    const sequence =
      armed && key.sequence.length === 1 ? ctrlCode(key.sequence) : key.sequence;
    this.keyPress.emit(sequence);
  }
}
