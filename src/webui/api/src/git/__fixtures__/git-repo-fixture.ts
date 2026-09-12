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
