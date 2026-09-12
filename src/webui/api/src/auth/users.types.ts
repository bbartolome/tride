export type UserRole = 'admin' | 'user';

/** A single row as it lives on disk in `${WEBUI_STATE_DIR}/users.json`. */
export interface UserEntry {
  login: string;
  role: UserRole;
  addedBy: string;
  addedAt: string;
}

/** The full shape of `users.json`. */
export interface UsersFileShape {
  version: 1;
  users: UserEntry[];
}

/** Result of `UsersService.isAllowed`. */
export interface AllowedUser {
  role: UserRole;
  seeded: boolean;
}

/** A row as returned by `UsersService.list` — a UserEntry plus its seeded flag. */
export type UserListEntry = UserEntry & { seeded: boolean };

// Matches both `user@example.com` and Tailscale's `user@github` form.
const LOGIN_RE = /^[^\s,@]{1,64}@[^\s,@]{1,189}$/;

export function isValidLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN_RE.test(value);
}

export function isValidRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'user';
}

/** Logins are stored/compared lowercased, matching WEBUI_ADMIN_LOGINS parsing. */
export function normalizeLoginForStorage(login: string): string {
  return login.trim().toLowerCase();
}
