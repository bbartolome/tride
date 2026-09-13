import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createAheadBehindFixture,
  createTempRepo,
  removeAheadBehindFixture,
  removeTempRepo,
  writeAndCommit,
  type AheadBehindFixture,
} from './__fixtures__/git-repo-fixture';
import { GitRemoteService, matchesAuthFailure } from './git-remote.service';
import { GitCommandError, GitRunner } from './git-runner.service';

/** A fresh bare repo under its own mkdtemp parent, standing in for a remote
 * with no network involved (F50/F74's filesystem-transport pattern). */
function createBareRepo(prefix: string): { parent: string; bareDir: string } {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const bareDir = join(parent, 'remote.git');
  mkdirSync(bareDir);
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main'], {
    cwd: bareDir,
  });
  return { parent, bareDir };
}

/** Clones `bareDir` into `dest` and sets the same LOCAL identity config
 * `createTempRepo` uses, for the same reason (F50): GitRunner's hardened
 * env never forwards the ambient GIT_AUTHOR_ or GIT_COMMITTER_ variables. */
function cloneWithIdentity(bareDir: string, dest: string): void {
  execFileSync('git', ['clone', '--quiet', bareDir, dest]);
  execFileSync('git', ['config', 'user.name', 'Fixture User'], {
    cwd: dest,
  });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], {
    cwd: dest,
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dest });
}

function revParse(dir: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd: dir })
    .toString()
    .trim();
}

function remoteBranches(dir: string): string {
  return execFileSync('git', ['branch', '-r'], { cwd: dir }).toString();
}

describe('matchesAuthFailure', () => {
  it.each([
    'Permission denied (publickey).',
    'Host key verification failed.',
    "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
    'Authentication failed',
    'authentication failed for https://example.com/org/repo.git/',
    "fatal: Authentication failed for 'https://example.com/org/repo.git/'",
    'remote: Invalid username or password.',
  ])('matches known auth-failure text: %s', (text) => {
    expect(matchesAuthFailure(text)).toBe(true);
  });

  it.each([
    'CONFLICT (content): Merge conflict in a.txt',
    'nothing to commit, working tree clean',
    'Everything up-to-date',
    'error: failed to push some refs (fetch first)',
  ])('does not match an unrelated message: %s', (text) => {
    expect(matchesAuthFailure(text)).toBe(false);
  });
});

describe('GitRemoteService', () => {
  let service: GitRemoteService;

  beforeEach(() => {
    service = new GitRemoteService(new GitRunner());
  });

  describe('fetch', () => {
    it('fetches a new remote branch, and prune removes one deleted on the remote', async () => {
      const fixture: AheadBehindFixture = createAheadBehindFixture();
      try {
        const pusher = join(fixture.parent, 'topic-pusher');
        cloneWithIdentity(fixture.bareDir, pusher);
        execFileSync('git', ['checkout', '--quiet', '-b', 'topic'], {
          cwd: pusher,
        });
        execFileSync('git', ['push', '--quiet', 'origin', 'topic'], {
          cwd: pusher,
        });

        await service.fetch(fixture.dir, {});
        expect(remoteBranches(fixture.dir)).toContain('origin/topic');

        execFileSync(
          'git',
          ['push', '--quiet', 'origin', '--delete', 'topic'],
          {
            cwd: pusher,
          },
        );

        // A plain fetch (no prune) leaves the now-stale tracking ref alone.
        await service.fetch(fixture.dir, {});
        expect(remoteBranches(fixture.dir)).toContain('origin/topic');

        // `prune: true` removes it.
        await service.fetch(fixture.dir, { prune: true });
        expect(remoteBranches(fixture.dir)).not.toContain('origin/topic');
      } finally {
        removeAheadBehindFixture(fixture);
      }
    });
  });

  describe('pull', () => {
    it('fast-forwards cleanly when the local branch has not diverged', async () => {
      const remote = createBareRepo('git-remote-pull-ff-');
      const cloneA = join(remote.parent, 'clone-a');
      const cloneB = join(remote.parent, 'clone-b');
      try {
        cloneWithIdentity(remote.bareDir, cloneA);
        writeAndCommit(cloneA, 'seed.txt', 'seed\n', 'seed commit');
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: cloneA,
        });
        execFileSync(
          'git',
          ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'],
          { cwd: cloneA },
        );

        cloneWithIdentity(remote.bareDir, cloneB);
        writeAndCommit(cloneB, 'far.txt', 'far\n', 'far commit');
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: cloneB,
        });

        await service.pull(cloneA, {});

        expect(revParse(cloneA, 'HEAD')).toBe(revParse(remote.bareDir, 'main'));
        expect(existsSync(join(cloneA, 'far.txt'))).toBe(true);
      } finally {
        rmSync(remote.parent, { recursive: true, force: true });
      }
    });

    it('fails cleanly on a real conflicting divergence -- --ff-only rejects up front, so MERGE_HEAD never gets a chance to appear', async () => {
      // Deliberately NOT createAheadBehindFixture: that fixture's two
      // divergent commits touch different files, so a merge attempt would
      // auto-resolve with no conflict at all -- which cannot distinguish
      // "rejected before any merge was attempted" (what --ff-only gives us)
      // from "attempted, auto-merged, and quietly created a merge commit"
      // (exactly the F48 failure mode this option exists to prevent). Both
      // clones here edit the SAME line of the SAME file, so an un-guarded
      // pull would start a real merge, hit a real conflict, and leave
      // MERGE_HEAD behind -- the discriminating signal this test needs.
      const parent = mkdtempSync(join(tmpdir(), 'git-remote-pull-conflict-'));
      try {
        const bareDir = join(parent, 'remote.git');
        mkdirSync(bareDir);
        execFileSync(
          'git',
          ['init', '--quiet', '--bare', '--initial-branch=main'],
          { cwd: bareDir },
        );

        const localDir = join(parent, 'local');
        cloneWithIdentity(bareDir, localDir);
        // Some real environments configure a default reconciliation
        // strategy globally (`pull.rebase`/`pull.ff`); set one LOCALLY here
        // so an un-guarded `git pull` attempts a merge instead of erroring
        // out earlier for having no configured strategy at all -- that
        // earlier, ambiguity-driven error is a real safety net in a bare
        // git config, but it is not our code's doing, so it must not be
        // what this test is actually credited to.
        execFileSync('git', ['config', 'pull.rebase', 'false'], {
          cwd: localDir,
        });
        writeAndCommit(localDir, 'conflict.txt', 'one\n', 'initial commit');
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: localDir,
        });
        execFileSync(
          'git',
          ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'],
          { cwd: localDir },
        );

        const otherDir = join(parent, 'other');
        cloneWithIdentity(bareDir, otherDir);
        writeFileSync(join(otherDir, 'conflict.txt'), 'remote-version\n');
        execFileSync('git', ['add', '-A'], { cwd: otherDir });
        execFileSync('git', ['commit', '--quiet', '-m', 'remote commit'], {
          cwd: otherDir,
        });
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: otherDir,
        });

        writeFileSync(join(localDir, 'conflict.txt'), 'local-version\n');
        execFileSync('git', ['add', '-A'], { cwd: localDir });
        execFileSync('git', ['commit', '--quiet', '-m', 'local commit'], {
          cwd: localDir,
        });
        execFileSync('git', ['fetch', '--quiet', 'origin'], {
          cwd: localDir,
        });

        const headBefore = revParse(localDir, 'HEAD');

        await expect(service.pull(localDir, {})).rejects.toBeInstanceOf(
          GitCommandError,
        );

        // The discriminating assertion: with --ff-only, git refuses before
        // ever attempting a merge, so MERGE_HEAD is never written.
        expect(existsSync(join(localDir, '.git', 'MERGE_HEAD'))).toBe(false);
        expect(revParse(localDir, 'HEAD')).toBe(headBefore);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  describe('push', () => {
    it('happy path pushes local commits to the bare remote', async () => {
      const remote = createBareRepo('git-remote-push-');
      const cloneA = join(remote.parent, 'clone-a');
      try {
        cloneWithIdentity(remote.bareDir, cloneA);
        writeAndCommit(cloneA, 'seed.txt', 'seed\n', 'seed commit');
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: cloneA,
        });
        execFileSync(
          'git',
          ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'],
          { cwd: cloneA },
        );

        writeAndCommit(cloneA, 'more.txt', 'more\n', 'more commit');
        await service.push(cloneA, {});

        expect(revParse(remote.bareDir, 'main')).toBe(revParse(cloneA, 'HEAD'));
      } finally {
        rmSync(remote.parent, { recursive: true, force: true });
      }
    });

    it('setUpstream sets the upstream on a first push with no prior tracking', async () => {
      const remote = createBareRepo('git-remote-push-upstream-');
      const dir = createTempRepo('git-remote-push-upstream-local-');
      try {
        writeAndCommit(dir, 'seed.txt', 'seed\n', 'seed commit');
        execFileSync('git', ['remote', 'add', 'origin', remote.bareDir], {
          cwd: dir,
        });

        // git itself requires an explicit branch alongside --set-upstream
        // when no upstream is configured yet (there's no "current branch's
        // upstream" to fall back on chicken-and-egg style) -- realistic
        // frontend usage always names the branch it's setting up.
        await service.push(dir, { setUpstream: true, branch: 'main' });

        expect(revParse(remote.bareDir, 'main')).toBe(revParse(dir, 'HEAD'));
        const upstream = execFileSync(
          'git',
          ['rev-parse', '--abbrev-ref', 'main@{upstream}'],
          { cwd: dir },
        )
          .toString()
          .trim();
        expect(upstream).toBe('origin/main');
      } finally {
        removeTempRepo(dir);
        rmSync(remote.parent, { recursive: true, force: true });
      }
    });

    it('force-with-lease is genuinely rejected by git when the lease is stale', async () => {
      const remote = createBareRepo('git-remote-force-stale-');
      const cloneA = join(remote.parent, 'clone-a');
      const cloneB = join(remote.parent, 'clone-b');
      try {
        cloneWithIdentity(remote.bareDir, cloneA);
        writeAndCommit(cloneA, 'seed.txt', 'seed\n', 'seed commit');
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: cloneA,
        });
        execFileSync(
          'git',
          ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'],
          { cwd: cloneA },
        );

        // A second clone advances the remote behind cloneA's back.
        cloneWithIdentity(remote.bareDir, cloneB);
        writeAndCommit(cloneB, 'b.txt', 'b\n', 'clone b commit');
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: cloneB,
        });
        const remoteShaAfterB = revParse(remote.bareDir, 'main');

        // cloneA never fetched, so its recorded knowledge of origin/main
        // (the "lease") is now stale relative to the actual remote.
        writeAndCommit(cloneA, 'a.txt', 'a\n', 'clone a commit');

        await expect(
          service.push(cloneA, { force: true }),
        ).rejects.toBeInstanceOf(GitCommandError);

        // A real rejection by git itself, not a simulated one -- the
        // remote must be entirely untouched by the rejected attempt.
        expect(revParse(remote.bareDir, 'main')).toBe(remoteShaAfterB);
      } finally {
        rmSync(remote.parent, { recursive: true, force: true });
      }
    });

    it('force-with-lease succeeds when the lease is valid (local history rewrite, remote unchanged since)', async () => {
      const remote = createBareRepo('git-remote-force-valid-');
      const cloneA = join(remote.parent, 'clone-a');
      try {
        cloneWithIdentity(remote.bareDir, cloneA);
        writeAndCommit(cloneA, 'seed.txt', 'seed\n', 'seed commit');
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], {
          cwd: cloneA,
        });
        execFileSync(
          'git',
          ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'],
          { cwd: cloneA },
        );

        // Rewrite local history. Nobody else has touched the remote since
        // cloneA's own push above, so its lease still matches the remote's
        // actual current tip -- --force-with-lease permits the overwrite
        // and --force-if-includes has nothing new to require.
        writeFileSync(join(cloneA, 'seed.txt'), 'seed\nmore\n');
        execFileSync('git', ['add', '-A'], { cwd: cloneA });
        execFileSync(
          'git',
          ['commit', '--quiet', '--amend', '-m', 'seed amended'],
          { cwd: cloneA },
        );

        await service.push(cloneA, { force: true });

        expect(revParse(remote.bareDir, 'main')).toBe(revParse(cloneA, 'HEAD'));
      } finally {
        rmSync(remote.parent, { recursive: true, force: true });
      }
    });
  });

  describe('listRemotes', () => {
    it('parses `git remote -v` into fetch/push URL pairs', async () => {
      const remote = createBareRepo('git-remote-list-');
      const dir = createTempRepo('git-remote-list-local-');
      try {
        execFileSync('git', ['remote', 'add', 'origin', remote.bareDir], {
          cwd: dir,
        });

        const result = await service.listRemotes(dir);

        expect(result).toEqual([
          { name: 'origin', fetchUrl: remote.bareDir, pushUrl: remote.bareDir },
        ]);
      } finally {
        removeTempRepo(dir);
        rmSync(remote.parent, { recursive: true, force: true });
      }
    });
  });
});
