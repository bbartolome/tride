import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { meGuard } from './me.guard';
import { SessionStatus } from './session.store';
import { SessionStore } from './session.store';

function stubSessionStore(status: SessionStatus): SessionStore {
  return {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    status: () => status,
  } as unknown as SessionStore;
}

async function runGuard(status: SessionStatus): Promise<boolean | UrlTree> {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: SessionStore, useValue: stubSessionStore(status) },
    ],
  });
  const result = await TestBed.runInInjectionContext(() =>
    meGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  );
  return result as boolean | UrlTree;
}

// Every branch of the guard, as a table: SessionStore.status() after
// ensureLoaded() resolves -> allow-or-redirect. `denied` covers BOTH 401
// (no identity, "role null") and 403 (an authenticated non-allowlisted
// login) — meGuard doesn't need to tell them apart to route to `/denied`.
describe('meGuard', () => {
  it.each<[string, SessionStatus]>([
    ['authenticated (role admin)', 'authenticated'],
    ['authenticated (role user)', 'authenticated'],
  ])('status=%s -> allows navigation', async (_label, status) => {
    const result = await runGuard(status);
    expect(result).toBe(true);
  });

  it('status=denied (no identity / not allowlisted) -> redirects to "/denied"', async () => {
    const result = await runGuard('denied');
    expect(result).not.toBe(true);
    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as UrlTree)).toBe('/denied');
  });

  it('status=error (a real 5xx/network failure) -> allows navigation rather than misreporting it as a denial', async () => {
    const result = await runGuard('error');
    expect(result).toBe(true);
  });
});
