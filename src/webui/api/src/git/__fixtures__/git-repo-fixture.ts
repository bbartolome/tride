// Test-only fixture helpers for exercising GitRunner (and later controllers)
// against real, throwaway git repositories. Never imported from production
// code — kept out of dist/ via tsconfig.build.json's `__fixtures__` exclude.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * Creates a fresh git repo in a mkdtemp'd directory and returns its path.
 *
 * Sets LOCAL (not global) `user.name`/`user.email`/`commit.gpgsign` —
 * local, because GitRunner's hardened env deliberately does not forward
 * `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. Without local config, a commit made
 * *through the app under test* would fall back to resolving identity from
 * the developer's real `~/.gitconfig`, and a global `commit.gpgsign=true`
 * would hang the test waiting on a GPG prompt.
 */
export function createTempRepo(prefix = 'git-fixture-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

/**
 * Writes `content` to `relPath` inside `dir` (creating parent directories
 * as needed), stages it, commits with `message`, and returns the new
 * commit's SHA.
 */
export function writeAndCommit(
  dir: string,
  relPath: string,
  content: string,
  message: string,
): string {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  execFileSync('git', ['add', '--', relPath], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })
    .toString()
    .trim();
}

/** Recursively removes a repo directory created by `createTempRepo`. */
export function removeTempRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** `git init` plus the same LOCAL identity config as `createTempRepo`, but
 * against a directory the caller already created (used when building a
 * multi-repo workspace where the repo must live at a specific path). */
function initLocalRepo(dir: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

export interface WorktreePairFixture {
  /** mkdtemp parent — a single `rmSync` on this cleans up both repos. */
  parent: string;
  primary: string;
  worktree: string;
}

/**
 * Creates a worktree pair (primary + sibling) under a common mkdtemp
 * parent. Mirrors the real `~/workspace/beacon-vscode` shape, where the
 * worktree's `.git` is a *file* pointing at
 * `<primary>/.git/worktrees/<name>`, not a directory.
 */
export function createWorktreePair(
  prefix = 'git-worktree-',
): WorktreePairFixture {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const primary = join(parent, 'primary');
  mkdirSync(primary);
  initLocalRepo(primary);
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial'], {
    cwd: primary,
  });

  const worktree = join(parent, 'worktree');
  execFileSync(
    'git',
    ['worktree', 'add', '--quiet', '-b', 'wt-branch', worktree],
    { cwd: primary },
  );

  return { parent, primary, worktree };
}

/** Removes a fixture created by `createWorktreePair`. */
export function removeWorktreePair(fixture: WorktreePairFixture): void {
  rmSync(fixture.parent, { recursive: true, force: true });
}

export interface MultiRepoWorkspace {
  /** The workspace root — pass this as WEBUI_WORKSPACE_ROOT. */
  root: string;
  plainRepo: string;
  worktreePrimary: string;
  worktreeSibling: string;
  /** A `.git` FILE pointing at a gitdir that does not exist — proves
   * classification failures are logged and skipped, not thrown. */
  brokenWorktree: string;
  /** `node_modules/fake-pkg/.git`, itself a file — proves the name-based
   * skip fires before any `.git` test ever runs against it. */
  nodeModulesGitFile: string;
  /** `.hidden/some-repo` — proves the dotdir skip. */
  hiddenRepo: string;
  /** `a/b/repo` — a real repo three levels down, beyond the depth-2 scan
   * cutoff. */
  depth3Repo: string;
  /** An ordinary directory with no `.git` anywhere in it. */
  plainNonRepoDir: string;
}

/**
 * Builds a single workspace root exercising every discovery edge case T8
 * cares about in one fixture: a plain repo, a worktree pair (both direct
 * children of `root`, so depth-2 scanning finds both sides), a broken
 * worktree pointer, a `node_modules` git-file that must be skipped by name
 * before it's ever `.git`-tested, a dotdir-nested repo, a depth-3 repo
 * beyond the scan cutoff, and a plain non-repo directory. A single
 * `removeMultiRepoWorkspace(root)` tears the whole thing down.
 */
export function createMultiRepoWorkspace(
  prefix = 'webui-workspace-',
): MultiRepoWorkspace {
  const root = mkdtempSync(join(tmpdir(), prefix));

  const plainRepo = join(root, 'plain-repo');
  mkdirSync(plainRepo);
  initLocalRepo(plainRepo);
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial'], {
    cwd: plainRepo,
  });

  const worktreePrimary = join(root, 'wt-primary');
  mkdirSync(worktreePrimary);
  initLocalRepo(worktreePrimary);
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial'], {
    cwd: worktreePrimary,
  });
  const worktreeSibling = join(root, 'wt-sibling');
  execFileSync(
    'git',
    ['worktree', 'add', '--quiet', '-b', 'wt-branch', worktreeSibling],
    { cwd: worktreePrimary },
  );

  const brokenWorktree = join(root, 'wt-broken');
  mkdirSync(brokenWorktree);
  writeFileSync(
    join(brokenWorktree, '.git'),
    'gitdir: /nonexistent/gitdir/for/broken/worktree\n',
  );

  const fakePkgDir = join(root, 'node_modules', 'fake-pkg');
  mkdirSync(fakePkgDir, { recursive: true });
  const nodeModulesGitFile = join(fakePkgDir, '.git');
  writeFileSync(nodeModulesGitFile, 'gitdir: /nonexistent\n');

  const hiddenRepo = join(root, '.hidden', 'some-repo');
  mkdirSync(hiddenRepo, { recursive: true });
  initLocalRepo(hiddenRepo);

  const depth3Repo = join(root, 'a', 'b', 'repo');
  mkdirSync(depth3Repo, { recursive: true });
  initLocalRepo(depth3Repo);

  const plainNonRepoDir = join(root, 'plain-dir');
  mkdirSync(plainNonRepoDir);
  writeFileSync(join(plainNonRepoDir, 'readme.txt'), 'nothing to see here');

  return {
    root,
    plainRepo,
    worktreePrimary,
    worktreeSibling,
    brokenWorktree,
    nodeModulesGitFile,
    hiddenRepo,
    depth3Repo,
    plainNonRepoDir,
  };
}

/** Removes a fixture created by `createMultiRepoWorkspace`. */
export function removeMultiRepoWorkspace(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T9 fixtures — `git status --porcelain=v2 -z` edge cases
// ---------------------------------------------------------------------------

export interface RenameStatusFixture {
  dir: string;
}

/**
 * A repo with a STAGED rename (`old.txt` -> `new.txt`, no content change, so
 * git reports it as a pure rename with a `R100` score) plus a second,
 * unrelated file modified but left unstaged. `second.txt` sorts after
 * `new.txt`, so its ordinary-change record follows the rename record in
 * real git's output — exactly the case that catches a desynchronized
 * cursor (a naive parse would misread `second.txt`'s record as the
 * rename's `origPath`).
 */
export function createRenameStatusFixture(): RenameStatusFixture {
  const dir = createTempRepo('git-status-rename-');
  writeAndCommit(
    dir,
    'old.txt',
    'line one\nline two\nline three\n',
    'add old.txt',
  );
  writeAndCommit(dir, 'second.txt', 'unchanged\n', 'add second.txt');
  execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir });
  writeFileSync(join(dir, 'second.txt'), 'unchanged\nmodified\n');
  return { dir };
}

export interface MergeConflictFixture {
  dir: string;
}

/**
 * A real, unresolved merge conflict: a base commit on `main`, a `feature`
 * branch that edits one line, `main` editing the same line differently,
 * then `git merge feature` — which fails and leaves genuine conflict
 * markers plus `MERGE_HEAD` in place. Built with raw `execFileSync`
 * throughout (merge is not, and will never be, an app-exposed operation,
 * so it must never go through `GitRunner`).
 */
export function createMergeConflictFixture(): MergeConflictFixture {
  const dir = createTempRepo('git-status-conflict-');
  writeAndCommit(dir, 'conflict.txt', 'base\n', 'base commit');

  execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: dir });
  writeFileSync(join(dir, 'conflict.txt'), 'feature change\n');
  execFileSync('git', ['add', '--', 'conflict.txt'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', 'feature change'], {
    cwd: dir,
  });

  execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'conflict.txt'), 'main change\n');
  execFileSync('git', ['add', '--', 'conflict.txt'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', 'main change'], {
    cwd: dir,
  });

  try {
    // Expected to fail (nonzero exit) — that failure IS the conflict.
    execFileSync('git', ['merge', '--quiet', '--no-edit', 'feature'], {
      cwd: dir,
      stdio: 'ignore',
    });
  } catch {
    // intentional
  }

  return { dir };
}

export interface UntrackedDirFixture {
  dir: string;
}

/**
 * A never-`git add`ed subdirectory containing a file. Git reports the
 * directory itself as a single `?` untracked record (with a trailing `/`),
 * not its contents individually.
 */
export function createUntrackedDirectoryFixture(): UntrackedDirFixture {
  const dir = createTempRepo('git-status-untracked-dir-');
  writeAndCommit(dir, 'tracked.txt', 'tracked\n', 'initial');
  const subdir = join(dir, 'newdir');
  mkdirSync(subdir);
  writeFileSync(join(subdir, 'inner.txt'), 'inner\n');
  return { dir };
}

export interface DetachedHeadFixture {
  dir: string;
  /** SHA of the first commit — the one HEAD is detached onto. */
  firstSha: string;
}

/**
 * Two commits, with HEAD detached onto the first via `--detach` (explicit,
 * to avoid the ordinary-checkout-of-a-branch-name ambiguity warning).
 */
export function createDetachedHeadFixture(): DetachedHeadFixture {
  const dir = createTempRepo('git-status-detached-');
  const firstSha = writeAndCommit(dir, 'a.txt', 'one\n', 'first');
  writeAndCommit(dir, 'a.txt', 'two\n', 'second');
  execFileSync('git', ['checkout', '--quiet', '--detach', firstSha], {
    cwd: dir,
  });
  return { dir, firstSha };
}

export interface AheadBehindFixture {
  /** mkdtemp parent — a single `rmSync` on this cleans up everything. */
  parent: string;
  /** The local repo under test: `main` tracks `origin/main`. */
  dir: string;
  bareDir: string;
}

/**
 * Bare-repo-as-remote pattern (F50): a local repo pushes an initial commit
 * to a bare "remote", a second clone pushes a *different* commit to that
 * same bare repo (simulating someone else's push), and the local repo then
 * makes its own divergent commit and fetches (without merging). The result
 * is a local `main` that is both ahead (its own new commit) and behind
 * (the other clone's commit, now sitting on `origin/main`) — both nonzero,
 * with no network involved.
 */
export function createAheadBehindFixture(): AheadBehindFixture {
  const parent = mkdtempSync(join(tmpdir(), 'git-status-ahead-behind-'));

  const bareDir = join(parent, 'remote.git');
  mkdirSync(bareDir);
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main'], {
    cwd: bareDir,
  });

  const dir = join(parent, 'local');
  mkdirSync(dir);
  initLocalRepo(dir);
  writeAndCommit(dir, 'file.txt', 'one\n', 'initial commit');
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: dir });
  execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: dir });
  execFileSync(
    'git',
    ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'],
    { cwd: dir },
  );

  const otherClone = join(parent, 'other-clone');
  execFileSync('git', ['clone', '--quiet', bareDir, otherClone]);
  execFileSync('git', ['config', 'user.name', 'Fixture User'], {
    cwd: otherClone,
  });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], {
    cwd: otherClone,
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: otherClone,
  });
  writeAndCommit(
    otherClone,
    'remote-file.txt',
    'remote change\n',
    'remote commit',
  );
  execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
    cwd: otherClone,
  });

  // Local's own divergent commit, then fetch (never merge) so the
  // `origin/main` tracking ref updates without touching local history —
  // this is what makes both `ahead` and `behind` nonzero simultaneously.
  writeAndCommit(dir, 'local-file.txt', 'local change\n', 'local commit');
  execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: dir });

  return { parent, dir, bareDir };
}

/** Removes a fixture created by `createAheadBehindFixture`. */
export function removeAheadBehindFixture(fixture: AheadBehindFixture): void {
  rmSync(fixture.parent, { recursive: true, force: true });
}
