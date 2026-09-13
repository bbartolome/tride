/**
 * Parses `git status --porcelain=v2 --branch -z` output.
 *
 * **Ownership note:** this file currently implements only the *header*
 * half — the `# branch.oid/head/upstream/ab` lines that `GitRepoService`
 * needs to build a `RepoSummary`. Entry-line parsing (staged/unstaged
 * files, renames, untracked, unmerged) is added by a later task in this
 * same file; that split is deliberate, not an omission — `GET
 * /api/git/status` (also a later task) is what actually needs entries,
 * while repo discovery only ever needs the header.
 *
 * Confirmed against git 2.43: even with `-z`, header lines are
 * NUL-terminated exactly like entry lines — the whole stream is one flat
 * sequence of NUL-separated records, never LF. So header and entry
 * records are split identically, which is why `splitPorcelainV2Records`
 * is exported for reuse rather than kept private.
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
