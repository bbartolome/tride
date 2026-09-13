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
