/**
 * Parses `git status --porcelain=v2 --branch -z` output.
 *
 * This file covers both halves: the `# branch.oid/head/upstream/ab` header
 * records (`parseGitStatusHeader`, needed by `GitRepoService` for
 * `RepoSummary`) and the entry records — ordinary changes, renames,
 * unmerged conflicts, untracked paths (`parseGitStatusEntries`, needed by
 * `GET /api/git/status`).
 *
 * Confirmed against git 2.43: even with `-z`, header lines are
 * NUL-terminated exactly like entry lines — the whole stream is one flat
 * sequence of NUL-separated records, never LF. So header and entry
 * records are split identically, which is why `splitPorcelainV2Records`
 * is exported for reuse rather than kept private.
 *
 * **The rename gotcha:** under `-z`, a rename/copy (`2`) record carries an
 * *extra* NUL-terminated field after it — the original path — that does
 * not show up as a space-separated token within the record itself. A naive
 * `records.map(parseOneRecord)` desynchronizes the instant a rename
 * appears: the next record consumed would actually be that rename's
 * `origPath`, not a real record. `parseGitStatusEntries` below therefore
 * walks the split array with an explicit index (a stateful cursor) and,
 * for a `2` record, consumes one extra array element as `origPath` before
 * continuing — this is not optional bookkeeping, it is the only thing that
 * keeps every record *after* a rename correctly aligned.
 */

const DETACHED_MARKER = '(detached)';
const BRANCH_HEAD_PREFIX = '# branch.head ';
const BRANCH_UPSTREAM_PREFIX = '# branch.upstream ';
const BRANCH_AB_RE = /^# branch\.ab \+(\d+) -(\d+)$/;

export interface GitStatusHeader {
  /** Current branch name, or null when detached or unparseable. */
  branch: string | null;
  /** True when HEAD is detached (branch.head is literally "(detached)"). */
  detached: boolean;
  /** Upstream ref (e.g. "origin/main"), or null when none is configured. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** True when any non-header record (staged/unstaged/untracked/unmerged/ignored) is present. */
  dirty: boolean;
}

/** Splits raw `--porcelain=v2 ... -z` stdout into non-empty NUL-delimited records. */
export function splitPorcelainV2Records(raw: string): string[] {
  return raw.split('\0').filter((record) => record.length > 0);
}

/** Parses just the `# branch.*` header records out of porcelain v2 output. */
export function parseGitStatusHeader(raw: string): GitStatusHeader {
  const header: GitStatusHeader = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
  };

  for (const record of splitPorcelainV2Records(raw)) {
    if (!record.startsWith('#')) {
      // Any non-header record — ordinary changes ('1'/'2'), unmerged ('u'),
      // untracked ('?') or ignored ('!') — means the tree is dirty.
      header.dirty = true;
      continue;
    }

    if (record.startsWith(BRANCH_HEAD_PREFIX)) {
      const value = record.slice(BRANCH_HEAD_PREFIX.length);
      if (value === DETACHED_MARKER) {
        header.detached = true;
        header.branch = null;
      } else {
        header.branch = value;
      }
      continue;
    }

    if (record.startsWith(BRANCH_UPSTREAM_PREFIX)) {
      header.upstream = record.slice(BRANCH_UPSTREAM_PREFIX.length);
      continue;
    }

    const abMatch = BRANCH_AB_RE.exec(record);
    if (abMatch) {
      header.ahead = Number.parseInt(abMatch[1], 10);
      header.behind = Number.parseInt(abMatch[2], 10);
    }
    // '# branch.oid ...' (and anything else unrecognized) carries no
    // information this header needs.
  }

  return header;
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

interface GitStatusEntryFlags {
  /** True when the index/X side (or, for `u` records, the "ours" side) is
   * anything but '.'. */
  staged: boolean;
  /** True when the worktree/Y side (or, for `u` records, the "theirs" side)
   * is anything but '.'. */
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
  /** Similarity score parsed out of the `R100`/`C75`-style score field. */
  score: number;
}

export interface UnmergedStatusEntry extends GitStatusEntryFlags {
  kind: 'unmerged';
  path: string;
}

export interface UntrackedStatusEntry {
  kind: 'untracked';
  /** Trailing slash stripped — see `isDirectory`. */
  path: string;
  /** True when git reported a whole untracked directory rather than a file
   * (git never expands an untracked directory's contents). */
  isDirectory: boolean;
}

export type GitStatusEntry =
  | OrdinaryStatusEntry
  | RenamedStatusEntry
  | UnmergedStatusEntry
  | UntrackedStatusEntry;

/** Derives `{staged, unstaged}` from a two-character XY code. */
function xyFlags(xy: string): GitStatusEntryFlags {
  return { staged: xy[0] !== '.', unstaged: xy[1] !== '.' };
}

/**
 * Splits a space-separated record into its first `fixedCount` tokens plus
 * everything remaining, rejoined with single spaces. The trailing "path"
 * field is never itself split further this way, since under `-z` it is not
 * quoted/escaped and may legitimately contain spaces.
 */
function splitFixedFields(
  record: string,
  fixedCount: number,
): { fields: string[]; rest: string } {
  const parts = record.split(' ');
  return {
    fields: parts.slice(0, fixedCount),
    rest: parts.slice(fixedCount).join(' '),
  };
}

function parseOrdinaryRecord(record: string): OrdinaryStatusEntry {
  // '1 XY sub mH mI mW hH hI path' — 8 fixed fields before the path.
  const { fields, rest } = splitFixedFields(record, 8);
  return { kind: 'ordinary', path: rest, ...xyFlags(fields[1]) };
}

function parseRenamedRecord(
  record: string,
  origPath: string,
): RenamedStatusEntry {
  // '2 XY sub mH mI mW hH hI Xscore path' — 9 fixed fields before the path;
  // origPath is the separate NUL-terminated field the caller already split
  // off via the stateful cursor.
  const { fields, rest } = splitFixedFields(record, 9);
  const scoreField = fields[8] ?? '';
  const score = Number.parseInt(scoreField.slice(1), 10);
  return {
    kind: 'renamed',
    path: rest,
    origPath,
    score: Number.isNaN(score) ? 0 : score,
    ...xyFlags(fields[1]),
  };
}

function parseUnmergedRecord(record: string): UnmergedStatusEntry {
  // 'u XY sub m1 m2 m3 mW h1 h2 h3 path' — 10 fixed fields before the path.
  const { fields, rest } = splitFixedFields(record, 10);
  return { kind: 'unmerged', path: rest, ...xyFlags(fields[1]) };
}

function parseUntrackedRecord(record: string): UntrackedStatusEntry {
  // '? path' — 1 fixed field before the path.
  const { rest } = splitFixedFields(record, 1);
  const isDirectory = rest.endsWith('/');
  return {
    kind: 'untracked',
    path: isDirectory ? rest.slice(0, -1) : rest,
    isDirectory,
  };
}

/**
 * Parses the entry records (everything but the `#` header lines) out of
 * porcelain v2 `-z` output: ordinary changes (`1`), renames/copies (`2`,
 * consuming the extra `origPath` field), unmerged/conflicted paths (`u`),
 * and untracked paths (`?`). `--ignored` is never passed by this app, so
 * `!` records are not expected and are ignored defensively if seen.
 *
 * Uses an explicit index-based cursor rather than `Array.map` specifically
 * so a `2` record can consume one extra array element — see the file
 * header comment for why a naive per-element parse would desynchronize.
 */
export function parseGitStatusEntries(raw: string): GitStatusEntry[] {
  const records = splitPorcelainV2Records(raw);
  const entries: GitStatusEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const typeChar = record[0];

    switch (typeChar) {
      case '#':
        continue;
      case '1':
        entries.push(parseOrdinaryRecord(record));
        continue;
      case '2': {
        // Consume the NEXT array element as origPath before advancing —
        // this is the desync-prevention step.
        i += 1;
        const origPath = records[i] ?? '';
        entries.push(parseRenamedRecord(record, origPath));
        continue;
      }
      case 'u':
        entries.push(parseUnmergedRecord(record));
        continue;
      case '?':
        entries.push(parseUntrackedRecord(record));
        continue;
      default:
        // Unrecognized record type (e.g. '!' if --ignored were ever
        // passed) — skip rather than throw.
        continue;
    }
  }

  return entries;
}
