import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import { dirname, join } from 'path';
import { AsyncMutex } from '../common/async-mutex';
import { ERROR_CODES } from '../common/error-codes';
import { WebuiConfigService } from '../config/webui-config.service';
import type {
  AllowedUser,
  UserEntry,
  UserListEntry,
  UserRole,
  UsersFileShape,
} from './users.types';

const EMPTY_ALLOWLIST_WARN_INTERVAL_MS = 60_000;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function isUserEntry(value: unknown): value is UserEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.login === 'string' &&
    (v.role === 'admin' || v.role === 'user') &&
    typeof v.addedBy === 'string' &&
    typeof v.addedAt === 'string'
  );
}

/** Throws on anything that isn't a well-formed `UsersFileShape`. */
function parseUsersFile(raw: string): UserEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('users.json: expected a JSON object');
  }
  const users = (parsed as Record<string, unknown>).users;
  if (!Array.isArray(users)) {
    throw new Error('users.json: expected a "users" array');
  }
  const entries: UserEntry[] = [];
  for (const candidate of users) {
    if (!isUserEntry(candidate)) {
      throw new Error('users.json: malformed user entry');
    }
    entries.push(candidate);
  }
  return entries;
}

function seededImmutable(): ConflictException {
  return new ConflictException({
    code: ERROR_CODES.SEEDED_IMMUTABLE,
    message: 'Login is a seeded admin and cannot be modified',
  });
}

/**
 * The runtime user allowlist store. Seeded admins (WEBUI_ADMIN_LOGINS, read
 * once at boot by WebuiConfigService) always win over a runtime entry of the
 * same login — see plan.md's "Auth" section. Backed by
 * `${stateDir}/users.json`; malformed content on disk must never wipe out
 * the in-memory allowlist (see `reloadIfChanged`).
 */
@Injectable()
export class UsersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsersService.name);
  private readonly seeded: Set<string>;
  private readonly filePath: string;
  private readonly mutex = new AsyncMutex();

  private runtime = new Map<string, UserEntry>();
  private lastMtimeMs = -1;
  private storeHealthy = true;
  private emptyAllowlistTimer?: ReturnType<typeof setInterval>;

  constructor(webuiConfig: WebuiConfigService) {
    this.seeded = new Set(webuiConfig.config.adminLogins);
    this.filePath = join(webuiConfig.config.stateDir, 'users.json');
  }

  onModuleInit(): void {
    this.emptyAllowlistTimer = setInterval(() => {
      if (this.seeded.size === 0 && this.runtime.size === 0) {
        this.logger.warn(
          'users allowlist is EMPTY: no seeded admins (WEBUI_ADMIN_LOGINS) and no runtime users — every request will be rejected until this is fixed',
        );
      }
    }, EMPTY_ALLOWLIST_WARN_INTERVAL_MS);
    // Never keep the process alive for this alone — matters for CLI/test runs.
    this.emptyAllowlistTimer.unref?.();
  }

  onModuleDestroy(): void {
    // Required or Jest hangs on the open interval handle.
    if (this.emptyAllowlistTimer) {
      clearInterval(this.emptyAllowlistTimer);
      this.emptyAllowlistTimer = undefined;
    }
  }

  isSeededLogin(login: string): boolean {
    return this.seeded.has(login);
  }

  async isAllowed(login: string): Promise<AllowedUser | null> {
    // A seeded login always wins and never depends on the runtime store's
    // health — losing that lookup to a truncated users.json would be an
    // outage on top of an outage.
    if (this.seeded.has(login)) {
      return { role: 'admin', seeded: true };
    }
    await this.reloadIfChanged();
    const entry = this.runtime.get(login);
    return entry ? { role: entry.role, seeded: false } : null;
  }

  async list(): Promise<UserListEntry[]> {
    await this.reloadIfChanged();
    const seededEntries: UserListEntry[] = Array.from(this.seeded).map(
      (login) => ({
        login,
        role: 'admin',
        addedBy: '',
        addedAt: '',
        seeded: true,
      }),
    );
    const runtimeEntries: UserListEntry[] = Array.from(this.runtime.values())
      // A runtime entry shadowed by a seeded login is ignored on read.
      .filter((entry) => !this.seeded.has(entry.login))
      .map((entry) => ({ ...entry, seeded: false }));
    return [...seededEntries, ...runtimeEntries];
  }

  async add(
    login: string,
    role: UserRole,
    addedBy: string,
  ): Promise<UserEntry> {
    return this.mutex.runExclusive(async () => {
      await this.reloadIfChanged();
      this.assertStoreHealthy();
      if (this.seeded.has(login)) {
        throw seededImmutable();
      }
      if (this.runtime.has(login)) {
        throw new ConflictException({
          code: ERROR_CODES.USER_EXISTS,
          message: `User ${login} already exists`,
        });
      }
      const entry: UserEntry = {
        login,
        role,
        addedBy,
        addedAt: new Date().toISOString(),
      };
      const next = new Map(this.runtime);
      next.set(login, entry);
      await this.persist(next);
      return entry;
    });
  }

  async update(login: string, role: UserRole): Promise<UserEntry> {
    return this.mutex.runExclusive(async () => {
      await this.reloadIfChanged();
      this.assertStoreHealthy();
      if (this.seeded.has(login)) {
        throw seededImmutable();
      }
      const existing = this.runtime.get(login);
      if (!existing) {
        throw new NotFoundException(`Unknown login: ${login}`);
      }
      const updated: UserEntry = { ...existing, role };
      const next = new Map(this.runtime);
      next.set(login, updated);
      await this.persist(next);
      return updated;
    });
  }

  async remove(login: string): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.reloadIfChanged();
      this.assertStoreHealthy();
      if (this.seeded.has(login)) {
        throw seededImmutable();
      }
      if (!this.runtime.has(login)) {
        throw new NotFoundException(`Unknown login: ${login}`);
      }
      const next = new Map(this.runtime);
      next.delete(login);
      await this.persist(next);
    });
  }

  private assertStoreHealthy(): void {
    if (!this.storeHealthy) {
      throw new ServiceUnavailableException({
        code: ERROR_CODES.USERS_STORE_UNAVAILABLE,
        message:
          'The user allowlist store is unavailable (users.json is missing or malformed); mutations are refused until it is fixed',
      });
    }
  }

  /**
   * `stat`s the file and, if its mtime moved since the last load (or it
   * disappeared/reappeared), re-reads it. Malformed content sets
   * `storeHealthy = false` and keeps the last-known-good `runtime` map —
   * it never resets to empty. `lastMtimeMs` is still advanced past a failed
   * parse so a call that keeps hitting the same broken file doesn't re-parse
   * (and re-log) on every single request; a subsequent edit bumps the mtime
   * again and triggers a fresh attempt.
   */
  private async reloadIfChanged(): Promise<void> {
    let stats;
    try {
      stats = await fsp.stat(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.runtime = new Map();
        this.lastMtimeMs = -1;
        this.storeHealthy = true;
        return;
      }
      this.storeHealthy = false;
      this.logger.error(
        `Unable to stat the users store at ${this.filePath}; refusing mutations until it is accessible again: ${String(
          (err as Error).message ?? err,
        )}`,
      );
      return;
    }

    if (stats.mtimeMs === this.lastMtimeMs) {
      return;
    }

    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const entries = parseUsersFile(raw);
      const map = new Map<string, UserEntry>();
      for (const entry of entries) {
        map.set(entry.login, entry);
      }
      this.runtime = map;
      this.storeHealthy = true;
    } catch (err) {
      this.storeHealthy = false;
      this.logger.error(
        `users.json is malformed at ${this.filePath}; keeping the last-known-good runtime allowlist in memory and refusing mutations until it is fixed: ${String(
          (err as Error).message ?? err,
        )}`,
      );
    } finally {
      this.lastMtimeMs = stats.mtimeMs;
    }
  }

  private async ensureStateDir(): Promise<void> {
    await fsp.mkdir(dirname(this.filePath), {
      recursive: true,
      mode: DIR_MODE,
    });
  }

  /**
   * Atomic write: `${filePath}.tmp-${pid}` in the same directory, chmod
   * 0600, fsync the fd, then rename over the real path. Never writes in
   * place. On any failure the tmp file is removed so it never leaks.
   */
  private async persist(nextRuntime: Map<string, UserEntry>): Promise<void> {
    await this.ensureStateDir();
    const payload: UsersFileShape = {
      version: 1,
      users: Array.from(nextRuntime.values()),
    };
    const json = JSON.stringify(payload, null, 2);
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;

    let handle: FileHandle | undefined;
    try {
      handle = await fsp.open(tmpPath, 'w', FILE_MODE);
      await handle.writeFile(json, 'utf8');
      await handle.chmod(FILE_MODE);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.rename(tmpPath, this.filePath);
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }

    const stats = await fsp.stat(this.filePath);
    this.runtime = nextRuntime;
    this.storeHealthy = true;
    this.lastMtimeMs = stats.mtimeMs;
  }
}
