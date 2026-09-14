import { Injectable, computed, signal } from '@angular/core';

export interface ConfirmDialogRequest {
  title: string;
  /** Plain text — state concretely what the action will do (F84). */
  body: string;
  /**
   * The exact text the confirm button requires, compared with `===` — no
   * trim, no case-folding (mirrors the server's own comparison for the
   * two flows that are server-verified: discard, force push). Pass one of
   * `DISCARD_CONFIRM_TEXT` / `FORCE_PUSH_CONFIRM_TEXT` (`core/confirm-
   * literals.ts`) for those two; a client-side-only confirmation (e.g.
   * force branch delete) may pass any other string, but callers must make
   * clear in `body`/comments that such a confirmation is not itself
   * enforced by the server.
   */
  requiredText: string;
}

/**
 * Single shared confirmation-dialog state, rendered by exactly one
 * `<app-confirm-dialog />` mounted at the app root (`app.html`) — every
 * feature that needs a typed confirmation injects this service and calls
 * `open()` rather than rolling its own dialog markup.
 *
 * `open()` returns a `Promise<boolean>` that resolves `true` only when the
 * user typed `requiredText` exactly and pressed confirm; `false` for
 * cancel (including dismissing without typing anything). Only one request
 * can be pending at a time — a second `open()` while one is showing
 * replaces the pending request's resolver, matching the fact that there
 * is only ever one dialog instance to show it in.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly _request = signal<ConfirmDialogRequest | null>(null);
  private readonly _inputValue = signal('');
  private resolver: ((result: boolean) => void) | null = null;

  readonly request = this._request.asReadonly();
  readonly inputValue = this._inputValue.asReadonly();

  /**
   * `===` against `requiredText` — deliberately NOT trimmed or
   * lowercased, mirroring the server's own comparison so a confirmation
   * that would 400 server-side is never shown as satisfied client-side.
   */
  readonly canConfirm = computed(() => {
    const req = this._request();
    return req !== null && this._inputValue() === req.requiredText;
  });

  open(request: ConfirmDialogRequest): Promise<boolean> {
    // A previously pending caller (should one somehow still be waiting)
    // is resolved false rather than left dangling forever.
    this.resolver?.(false);
    this._request.set(request);
    this._inputValue.set('');
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  setInput(value: string): void {
    this._inputValue.set(value);
  }

  confirm(): void {
    if (!this.canConfirm()) {
      return;
    }
    this.settle(true);
  }

  cancel(): void {
    this.settle(false);
  }

  private settle(result: boolean): void {
    const resolve = this.resolver;
    this.resolver = null;
    this._request.set(null);
    this._inputValue.set('');
    resolve?.(result);
  }
}
