import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { adminGuard } from './admin.guard';
import { MeResponse } from './api.types';
import { SessionStore } from './session.store';

function stubSessionStore(identity: MeResponse | null): SessionStore {
  return { identity: () => identity } as unknown as SessionStore;
}

function runGuard(identity: MeResponse | null): boolean | UrlTree {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: SessionStore, useValue: stubSessionStore(identity) },
    ],
  });
  return TestBed.runInInjectionContext(() =>
    adminGuard(
      {} as ActivatedRouteSnapshot,
      {} as RouterStateSnapshot,
    ),
  ) as boolean | UrlTree;
}

// Every branch of the guard, as a table: role -> allow-or-redirect.
describe('adminGuard', () => {
  it.each<[string, MeResponse | null]>([
    ['admin', { login: 'boss@example.com', role: 'admin', seeded: true }],
  ])('role=%s -> allows navigation', (_label, identity) => {
    const result = runGuard(identity);
    expect(result).toBe(true);
  });

  it.each<[string, MeResponse | null]>([
    ['user', { login: 'plain@example.com', role: 'user', seeded: false }],
    ['null identity', null],
  ])('role=%s -> redirects to "/" (not "/denied")', (_label, identity) => {
    const result = runGuard(identity);
    expect(result).not.toBe(true);
    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as UrlTree)).toBe('/');
  });
});
