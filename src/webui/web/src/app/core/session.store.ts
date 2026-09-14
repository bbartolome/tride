import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiClient } from './api.client';
import { ApiError } from './error.interceptor';
import { MeResponse } from './api.types';

export type SessionStatus =
  | 'idle'
  | 'loading'
  | 'authenticated'
  | 'denied'
  | 'error';

/**
 * Loads `/api/me` exactly once (subsequent `ensureLoaded()` calls reuse the
 * in-flight/settled promise) and exposes the result as signals. `denied`
 * covers both 401 (AUTH_REQUIRED — Tailscale sent no/invalid identity) and
 * 403 (NOT_ALLOWED — identity known but not on the allowlist); the caller
 * doesn't need to distinguish them to decide whether to route to
 * `/denied`, only `MeGuard` needs the raw status.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(ApiClient);

  private readonly _status = signal<SessionStatus>('idle');
  private readonly _identity = signal<MeResponse | null>(null);
  private readonly _error = signal<ApiError | null>(null);
  private loadPromise: Promise<void> | null = null;

  readonly status = this._status.asReadonly();
  readonly identity = this._identity.asReadonly();
  readonly error = this._error.asReadonly();

  readonly isAdmin = computed(() => this._identity()?.role === 'admin');

  /** Idempotent: safe to call from every route's guard/resolver. */
  ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.load();
    }
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    this._status.set('loading');
    try {
      const me = await firstValueFrom(this.api.me());
      this._identity.set(me);
      this._status.set('authenticated');
    } catch (err) {
      const apiError = err as ApiError;
      this._error.set(apiError);
      if (apiError.status === 401 || apiError.status === 403) {
        this._status.set('denied');
      } else {
        this._status.set('error');
      }
    }
  }
}
