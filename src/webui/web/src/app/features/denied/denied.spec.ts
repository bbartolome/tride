import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/error.interceptor';
import { SessionStore } from '../../core/session.store';
import { Denied } from './denied';

function setup(error: ApiError | null) {
  TestBed.configureTestingModule({
    imports: [Denied],
    providers: [
      provideZonelessChangeDetection(),
      { provide: SessionStore, useValue: { error: () => error } as unknown as SessionStore },
    ],
  });
  return TestBed.createComponent(Denied);
}

describe('Denied', () => {
  it('shows the rejected login when detail.login is present (403 NOT_ALLOWED)', async () => {
    const fixture = setup({
      status: 403,
      code: 'NOT_ALLOWED',
      message: 'Not allowed',
      detail: { login: 'nobody@example.com' },
    });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.login')?.textContent).toBe('nobody@example.com');
    expect(root.querySelector('.summary')?.textContent).not.toContain('No Tailscale identity');
  });

  it('shows a generic "no identity presented" message when there is no detail (401 AUTH_REQUIRED)', async () => {
    const fixture = setup({
      status: 401,
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.login')).toBeNull();
    expect(root.querySelector('.summary')?.textContent).toContain('No Tailscale identity');
  });

  it('shows the generic message when there is no error at all', async () => {
    const fixture = setup(null);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.login')).toBeNull();
    expect(root.querySelector('.summary')?.textContent).toContain('No Tailscale identity');
  });

  it('explains the allowlist model: admin-managed, seeded admins immutable, no read-only role', async () => {
    const fixture = setup(null);
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).querySelector('.explain')?.textContent ?? '';
    expect(text).toContain('WEBUI_ADMIN_LOGINS');
    expect(text).toContain('can never be removed');
    expect(text.toLowerCase()).toContain('read-only role');
  });
});
