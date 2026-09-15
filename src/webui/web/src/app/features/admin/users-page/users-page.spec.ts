import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { MeResponse, UserListEntry } from '../../../core/api.types';
import { SessionStore } from '../../../core/session.store';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { UsersPage } from './users-page';

const SEEDED_ROW: UserListEntry = {
  login: 'seeded-admin@example.com',
  role: 'admin',
  addedBy: '',
  addedAt: '',
  seeded: true,
};

const RUNTIME_ROW: UserListEntry = {
  login: 'runtime-user@example.com',
  role: 'user',
  addedBy: 'seeded-admin@example.com',
  addedAt: '2024-01-01T00:00:00.000Z',
  seeded: false,
};

describe('UsersPage', () => {
  let listUsers: ReturnType<typeof vi.fn>;
  let addUser: ReturnType<typeof vi.fn>;
  let updateUserRole: ReturnType<typeof vi.fn>;
  let removeUser: ReturnType<typeof vi.fn>;
  let confirmDialog: ConfirmDialogService;

  function setup(selfIdentity: MeResponse) {
    listUsers = vi.fn().mockReturnValue(of([SEEDED_ROW, RUNTIME_ROW]));
    addUser = vi.fn().mockReturnValue(of({ ...RUNTIME_ROW }));
    updateUserRole = vi.fn().mockReturnValue(of({ ...RUNTIME_ROW }));
    removeUser = vi.fn().mockReturnValue(of({ ok: true }));

    TestBed.configureTestingModule({
      imports: [UsersPage],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiClient,
          useValue: {
            listUsers,
            addUser,
            updateUserRole,
            removeUser,
          } as unknown as ApiClient,
        },
        {
          provide: SessionStore,
          useValue: { identity: () => selfIdentity } as unknown as SessionStore,
        },
      ],
    });
    confirmDialog = TestBed.inject(ConfirmDialogService);
  }

  function rowByLogin(root: HTMLElement, login: string): HTMLElement {
    return Array.from(root.querySelectorAll('.user-row')).find((r) =>
      r.querySelector('.login')?.textContent?.includes(login),
    ) as HTMLElement;
  }

  describe('as the runtime (non-seeded) user themselves', () => {
    beforeEach(() => {
      setup({ login: 'runtime-user@example.com', role: 'user', seeded: false });
    });

    it('renders one row per user with the right columns', async () => {
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelectorAll('.user-row').length).toBe(2);
      const seededRow = rowByLogin(root, 'seeded-admin@example.com');
      expect(seededRow.querySelector('.seeded')?.textContent).toBe('yes');
      const runtimeRow = rowByLogin(root, 'runtime-user@example.com');
      expect(runtimeRow.querySelector('.seeded')?.textContent).toBe('no');
      expect(runtimeRow.querySelector('.added-by')?.textContent).toContain(
        'seeded-admin@example.com',
      );
    });

    it('disables the seeded row\'s role toggle and remove button, with an explanatory reason', async () => {
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const seededRow = rowByLogin(root, 'seeded-admin@example.com');

      const roleBtn = seededRow.querySelector('.role-toggle') as HTMLButtonElement;
      const removeBtn = seededRow.querySelector('.remove') as HTMLButtonElement;
      expect(roleBtn.disabled).toBe(true);
      expect(removeBtn.disabled).toBe(true);
      expect(seededRow.querySelector('.disabled-reason')?.textContent).toContain('Seeded');
    });

    it('disables only remove (not the role toggle) on the caller\'s own row', async () => {
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const selfRow = rowByLogin(root, 'runtime-user@example.com');

      expect(selfRow.classList.contains('self')).toBe(true);
      const roleBtn = selfRow.querySelector('.role-toggle') as HTMLButtonElement;
      const removeBtn = selfRow.querySelector('.remove') as HTMLButtonElement;
      expect(roleBtn.disabled).toBe(false);
      expect(removeBtn.disabled).toBe(true);
      expect(selfRow.querySelector('.disabled-reason')?.textContent).toContain('own account');
    });

    it('rejects an invalid login client-side without calling addUser', async () => {
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;

      const loginInput = root.querySelector('#new-login') as HTMLInputElement;
      loginInput.value = 'not-a-login';
      loginInput.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      (root.querySelector('.add-user button') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(addUser).not.toHaveBeenCalled();
      expect(root.querySelector('.form-error')?.textContent).toContain('user@example.com');
    });

    it('adds a user with a valid login and the selected role, then clears the form', async () => {
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;

      const loginInput = root.querySelector('#new-login') as HTMLInputElement;
      loginInput.value = 'newbie@example.com';
      loginInput.dispatchEvent(new Event('input'));
      const roleSelect = root.querySelector('#new-role') as HTMLSelectElement;
      roleSelect.value = 'admin';
      roleSelect.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      (root.querySelector('.add-user button') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(addUser).toHaveBeenCalledWith('newbie@example.com', 'admin');
      expect((root.querySelector('#new-login') as HTMLInputElement).value).toBe('');
    });

    it('toggling a non-seeded row\'s role calls updateUserRole with the flipped role', async () => {
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const selfRow = rowByLogin(root, 'runtime-user@example.com');

      (selfRow.querySelector('.role-toggle') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(updateUserRole).toHaveBeenCalledWith('runtime-user@example.com', 'admin');
    });

    it('removing a removable row goes through a client-side confirm requiring the exact login', async () => {
      // Neither fixture row is removable (one seeded, one self) — use a
      // third, removable row instead.
      listUsers.mockReturnValue(
        of([SEEDED_ROW, RUNTIME_ROW, { ...RUNTIME_ROW, login: 'someone-else@example.com' }]),
      );
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const otherRow = rowByLogin(root, 'someone-else@example.com');
      const removeBtn = otherRow.querySelector('.remove') as HTMLButtonElement;
      expect(removeBtn.disabled).toBe(false);

      removeBtn.click();
      await fixture.whenStable();
      expect(removeUser).not.toHaveBeenCalled();
      expect(confirmDialog.request()?.requiredText).toBe('someone-else@example.com');

      confirmDialog.setInput('someone-else@example.com');
      confirmDialog.confirm();
      await fixture.whenStable();

      expect(removeUser).toHaveBeenCalledWith('someone-else@example.com');
    });
  });

  describe('precedence (F30): a seeded admin who is also the caller', () => {
    beforeEach(() => {
      setup({ login: 'seeded-admin@example.com', role: 'admin', seeded: true });
    });

    it('shows the seeded reason, not the self-removal reason, on their own row', async () => {
      const fixture = TestBed.createComponent(UsersPage);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const selfRow = rowByLogin(root, 'seeded-admin@example.com');

      expect(selfRow.classList.contains('self')).toBe(true);
      const reason = selfRow.querySelector('.disabled-reason')?.textContent ?? '';
      expect(reason).toContain('Seeded');
      expect(reason).not.toContain('own account');
    });
  });
});
