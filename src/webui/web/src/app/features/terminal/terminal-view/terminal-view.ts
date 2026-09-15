import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { TerminalConnectionState, TerminalSocket } from '../../../core/terminal-socket';
import { KeyBar } from '../../../shared/key-bar/key-bar';

const RESIZE_DEBOUNCE_MS = 150;

const STATUS_LABELS: Record<TerminalConnectionState, string> = {
  connecting: 'Connecting…',
  ready: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Closed',
};

/**
 * `/terminal/:id` — one full-screen xterm instance wired to one
 * `TerminalSocket`.
 *
 * Bytes flow exactly two ways, both funneling through
 * `TerminalSocket.sendInput()` — never a second, independent
 * `ws.send()` path:
 *  - real typing: `term.onData(...)`
 *  - the mobile `KeyBar`'s `(keyPress)` output
 *
 * `FitAddon` runs on a debounced `ResizeObserver` (~150ms) so a rotation
 * or the on-screen keyboard opening/closing resizes the pane without a
 * storm of `resize` control frames; each fit is followed by exactly one
 * `resize` frame to the server.
 *
 * A clean PTY exit (`{type:'exit'}`) disposes the socket outright rather
 * than letting the normal close-triggered reconnect loop retry forever
 * against a session that is now gone — tmux typically kills a session
 * once its last pane's process exits, so re-attaching after a genuine
 * exit is not a transient failure to retry through, unlike a dropped
 * network connection.
 */
@Component({
  selector: 'app-terminal-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, KeyBar],
  templateUrl: './terminal-view.html',
  styleUrl: './terminal-view.scss',
})
export class TerminalView implements AfterViewInit, OnDestroy {
  private readonly api = inject(ApiClient);

  readonly id = input.required<string>();

  private readonly terminalHost =
    viewChild.required<ElementRef<HTMLElement>>('terminalHost');

  protected readonly connectionState = signal<TerminalConnectionState>('connecting');
  protected readonly exitCode = signal<number | null>(null);
  protected readonly statusLabel = computed(() => STATUS_LABELS[this.connectionState()]);

  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private socket: TerminalSocket | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounce: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    const term = new Terminal({ cursorBlink: true, convertEol: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(this.terminalHost().nativeElement);
    fitAddon.fit();
    this.term = term;
    this.fitAddon = fitAddon;

    const terminalId = this.id();
    const socket = new TerminalSocket(
      terminalId,
      () => firstValueFrom(this.api.mintTerminalTicket(terminalId)),
      {
        // Straight through, untouched — never decode to a string first
        // (would corrupt a UTF-8 sequence split across frames).
        onBinary: (data) => term.write(data),
        onState: (state) => this.connectionState.set(state),
        onExit: (exitCode) => {
          this.exitCode.set(exitCode);
          // See class doc — a clean exit is not a transient failure to
          // keep retrying against.
          this.socket?.dispose();
        },
      },
      { cols: term.cols, rows: term.rows },
    );
    this.socket = socket;
    socket.start();

    // Real typing. The mobile key bar below calls the exact same
    // `sendInput` — see `onKeyBarPress`.
    term.onData((data) => socket.sendInput(data));

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.terminalHost().nativeElement);
  }

  /** The key bar's ONLY path to the server — identical to `term.onData`
   * above, both ending in `TerminalSocket.sendInput()`. */
  protected onKeyBarPress(data: string): void {
    this.socket?.sendInput(data);
  }

  private scheduleFit(): void {
    if (this.resizeDebounce !== null) {
      clearTimeout(this.resizeDebounce);
    }
    this.resizeDebounce = setTimeout(() => {
      this.resizeDebounce = null;
      if (!this.term || !this.fitAddon) {
        return;
      }
      this.fitAddon.fit();
      this.socket?.resize(this.term.cols, this.term.rows);
    }, RESIZE_DEBOUNCE_MS);
  }

  ngOnDestroy(): void {
    if (this.resizeDebounce !== null) {
      clearTimeout(this.resizeDebounce);
    }
    this.resizeObserver?.disconnect();
    this.socket?.dispose();
    this.term?.dispose();
  }
}
