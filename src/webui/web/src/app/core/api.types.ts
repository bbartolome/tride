/**
 * Hand-mirrored TypeScript interfaces for every `/api/*` response and error
 * shape the Nest backend (`src/webui/api`) returns.
 *
 * IMPORTANT — drift control: `src/webui/api` and `src/webui/web` are two
 * separate npm packages that share NO types at build time (no shared
 * package, no `.d.ts` re-export, nothing enforced by the compiler). This
 * file is therefore the *only* thing keeping the two in sync, and it is
 * only as good as the last time someone read it against the real
 * controllers/services and updated it by hand. Every block below is
 * commented with the exact API source file it mirrors — when a controller
 * or service return type changes, this file must be updated by hand to
 * match, or the client will silently drift out of sync with the server.
 */

// ---------------------------------------------------------------------------
// common/error-codes.ts
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NOT_ALLOWED: 'NOT_ALLOWED',
  SEEDED_IMMUTABLE: 'SEEDED_IMMUTABLE',
  USER_EXISTS: 'USER_EXISTS',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  USERS_STORE_UNAVAILABLE: 'USERS_STORE_UNAVAILABLE',
  PATH_OUTSIDE_WORKSPACE: 'PATH_OUTSIDE_WORKSPACE',
  GIT_COMMAND_FAILED: 'GIT_COMMAND_FAILED',
  GIT_TIMEOUT: 'GIT_TIMEOUT',
  INVALID_PATHSPEC: 'INVALID_PATHSPEC',
  REPO_NOT_FOUND: 'REPO_NOT_FOUND',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  NOTHING_TO_COMMIT: 'NOTHING_TO_COMMIT',
  INVALID_REF: 'INVALID_REF',
  BRANCH_EXISTS: 'BRANCH_EXISTS',
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  GIT_AUTH_REQUIRED: 'GIT_AUTH_REQUIRED',
  STASH_NOT_FOUND: 'STASH_NOT_FOUND',
  TERMINAL_NOT_FOUND: 'TERMINAL_NOT_FOUND',
  TICKET_INVALID: 'TICKET_INVALID',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * common/app-exception.filter.ts — `AppExceptionFilter` guarantees this
 * envelope shape on EVERY non-2xx response (either from an HttpException's
 * body, or synthesized for an unhandled error / a bare HttpException with a
 * string body).
 */
export interface ErrorEnvelope {
  code: string;
  message: string;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// auth/users.controller.ts, auth/users.types.ts
// ---------------------------------------------------------------------------

export type UserRole = 'admin' | 'user';

/** GET /api/me — auth/users.controller.ts `MeResponse`. */
export interface MeResponse {
  login: string;
  name?: string;
  picture?: string;
  role?: UserRole;
  seeded?: boolean;
}

/** GET /api/users row — auth/users.types.ts `UserListEntry`. */
export interface UserListEntry {
  login: string;
  role: UserRole;
  addedBy: string;
  addedAt: string;
  seeded: boolean;
}

// ---------------------------------------------------------------------------
// workspace/workspace.controller.ts
// ---------------------------------------------------------------------------

export interface TreeEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  /** Cheap `.git` lstat only — never a git subprocess. */
  isRepo?: boolean;
}

/** GET /api/fs/tree */
export interface TreeResponse {
  path: string;
  entries: TreeEntry[];
}

/** GET /api/fs/file */
export interface FileResponse {
  binary: boolean;
  size: number;
  content?: string;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// git/git-repo.service.ts
// ---------------------------------------------------------------------------

/** GET /api/repos row — `RepoSummary`. */
export interface RepoSummary {
  /** Repo-relative to WEBUI_WORKSPACE_ROOT; pass back verbatim as `repo`. */
  path: string;
  name: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  isWorktree: boolean;
}

// ---------------------------------------------------------------------------
// git/git-status-parser.ts, git/git-status.service.ts
// ---------------------------------------------------------------------------

interface GitStatusEntryFlags {
  staged: boolean;
  unstaged: boolean;
}

export interface OrdinaryStatusEntry extends GitStatusEntryFlags {
  kind: 'ordinary';
  path: string;
}

export interface RenamedStatusEntry extends GitStatusEntryFlags {
  kind: 'renamed';
  path: string;
  origPath: string;
  score: number;
}

export interface UnmergedStatusEntry extends GitStatusEntryFlags {
  kind: 'unmerged';
  path: string;
}

export interface UntrackedStatusEntry {
  kind: 'untracked';
  path: string;
  isDirectory: boolean;
}

export type GitStatusEntry =
  | OrdinaryStatusEntry
  | RenamedStatusEntry
  | UnmergedStatusEntry
  | UntrackedStatusEntry;

/** GET /api/git/status — `GitStatusResult`. */
export interface GitStatusResult {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

// ---------------------------------------------------------------------------
// git/git-diff.service.ts
// ---------------------------------------------------------------------------

/** GET /api/git/diff — `DiffResponse`. */
export type DiffResponse = { text: string } | { binary: true };

/** GET /api/git/diff/summary row — `DiffSummaryEntry`. */
export interface DiffSummaryEntry {
  path: string;
  /** Present only for renames/copies. */
  origPath?: string;
  /** null for a binary file. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

// ---------------------------------------------------------------------------
// git/git-log.service.ts
// ---------------------------------------------------------------------------

export interface GitCommitInfo {
  sha: string;
  author: string;
  email: string;
  /** Strict ISO 8601. */
  date: string;
  message: string;
}

/** GET /api/git/log row — `GitLogEntry`. */
export type GitLogEntry = GitCommitInfo;

/** GET /api/git/show — `GitShowResult`. */
export interface GitShowResult {
  header: GitCommitInfo;
  diffText: string;
}

// ---------------------------------------------------------------------------
// git/git-changes.service.ts
// ---------------------------------------------------------------------------

/** POST /api/git/commit — `CommitResult`. */
export interface CommitResult {
  sha: string;
}

// ---------------------------------------------------------------------------
// git/git-branch.service.ts
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
}

export interface RemoteBranchInfo {
  name: string;
  sha: string;
}

/** GET /api/git/branches — `BranchListResult`. */
export interface BranchListResult {
  current: string | null;
  detached: boolean;
  /** Short SHA HEAD is detached onto — present only when `detached` is true. */
  detachedAt?: string;
  local: BranchInfo[];
  remote: RemoteBranchInfo[];
}

// ---------------------------------------------------------------------------
// git/git-remote.service.ts
// ---------------------------------------------------------------------------

/** GET /api/git/remotes row — `RemoteInfo`. */
export interface RemoteInfo {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
}

// ---------------------------------------------------------------------------
// git/git-stash.service.ts
// ---------------------------------------------------------------------------

/** GET /api/git/stash row — `StashEntry`. */
export interface StashEntry {
  ref: string;
  sha: string;
  date: string;
  message: string;
}

// ---------------------------------------------------------------------------
// terminal/terminal.controller.ts
// ---------------------------------------------------------------------------

export type TerminalMode = 'shell' | 'claude';

/** GET/POST /api/terminals — `TerminalSummary`. */
export interface TerminalSummary {
  id: string;
  /** Workspace-relative — an absolute host path never reaches the client. */
  cwd: string;
  mode: TerminalMode;
  label: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// terminal/terminal-ticket.service.ts
// ---------------------------------------------------------------------------

/** POST /api/terminals/:id/ticket — `MintedTicket`. */
export interface MintedTicket {
  ticket: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Generic `{ ok: true }` acknowledgement shared by every git/terminal
// mutation endpoint that returns no richer payload (stage, unstage,
// discard, checkout, branch create/delete, fetch, pull, push, stash
// push/apply/pop/drop, users delete).
// ---------------------------------------------------------------------------

export interface OkResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// health/health.controller.ts
// ---------------------------------------------------------------------------

/** GET /healthz (not under /api — excluded from the SPA catch-all). */
export interface HealthResponse {
  status: 'ok';
}
