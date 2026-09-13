import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { execFileSync } from 'child_process';
import {
  createAheadBehindFixture,
  createDetachedHeadFixture,
  createTempRepo,
  removeAheadBehindFixture,
  removeTempRepo,
  writeAndCommit,
} from './__fixtures__/git-repo-fixture';
import { GitBranchService } from './git-branch.service';
import { GitCommandError, GitRunner } from './git-runner.service';

function currentBranch(dir: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dir,
  })
    .toString()
    .trim();
}

function headSha(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })
    .toString()
    .trim();
}

describe('GitBranchService', () => {
  let service: GitBranchService;

  beforeEach(() => {
    service = new GitBranchService(new GitRunner());
  });

  describe('listBranches', () => {
    it('lists local branches with upstream and correctly nonzero ahead/behind (real divergence)', async () => {
      const fixture = createAheadBehindFixture();
      try {
        // A second, untracked local branch alongside `main`.
        execFileSync('git', ['branch', 'topic'], { cwd: fixture.dir });

        const result = await service.listBranches(fixture.dir);

        expect(result.current).toBe('main');
        expect(result.detached).toBe(false);

        const main = result.local.find((b) => b.name === 'main');
        expect(main).toBeDefined();
        expect(main).toMatchObject({
          upstream: 'origin/main',
          upstreamGone: false,
        });
        // Real divergence built by the fixture, not fabricated: local made
        // its own commit (ahead) after the other clone's commit landed on
        // origin/main (behind).
        expect(main!.ahead).toBe(1);
        expect(main!.behind).toBe(1);

        const topic = result.local.find((b) => b.name === 'topic');
        expect(topic).toMatchObject({ upstream: null, ahead: 0, behind: 0 });
      } finally {
        removeAheadBehindFixture(fixture);
      }
    });

    it('reports a detached HEAD as current:null, detached:true, with detachedAt set', async () => {
      const fixture = createDetachedHeadFixture();
      try {
        const result = await service.listBranches(fixture.dir);

        expect(result.current).toBeNull();
        expect(result.detached).toBe(true);
        expect(result.detachedAt).toBeDefined();
        // Short SHA of the commit HEAD is detached onto.
        expect(fixture.firstSha.startsWith(result.detachedAt as string)).toBe(
          true,
        );
      } finally {
        removeTempRepo(fixture.dir);
      }
    });

    it('filters out refs/remotes/origin/HEAD (a symbolic pointer, not a branch)', async () => {
      const fixture = createAheadBehindFixture();
      try {
        execFileSync('git', ['remote', 'set-head', 'origin', '-a'], {
          cwd: fixture.dir,
        });

        const result = await service.listBranches(fixture.dir);

        expect(result.remote.some((r) => r.name === 'origin')).toBe(false);
        expect(result.remote.some((r) => r.name === 'origin/main')).toBe(true);
      } finally {
        removeAheadBehindFixture(fixture);
      }
    });

    it('reports upstreamGone:true when the upstream remote-tracking ref has been deleted', async () => {
      const fixture = createAheadBehindFixture();
      try {
        execFileSync('git', ['branch', '-r', '-d', 'origin/main'], {
          cwd: fixture.dir,
        });

        const result = await service.listBranches(fixture.dir);

        const main = result.local.find((b) => b.name === 'main');
        expect(main).toMatchObject({
          upstream: 'origin/main',
          upstreamGone: true,
          ahead: 0,
          behind: 0,
        });
      } finally {
        removeAheadBehindFixture(fixture);
      }
    });
  });

  describe('checkout', () => {
    it('checks out an existing branch', async () => {
      const dir = createTempRepo('git-branch-checkout-existing-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        execFileSync('git', ['branch', 'other'], { cwd: dir });

        await service.checkout(dir, { branch: 'other' });

        expect(currentBranch(dir)).toBe('other');
      } finally {
        removeTempRepo(dir);
      }
    });

    // A bare SHA is the shape the task calls out explicitly. Verified
    // directly against real git 2.43 (see the mutation-test note below):
    // a full 40-hex-char SHA happens to ALSO satisfy `check-ref-format
    // --branch`'s syntax rules (it contains no '/', '~', '^', ':', space,
    // etc.), so on its own this case does not actually distinguish
    // "startPoint validated with checkRefFormat" from "startPoint not
    // validated at all" — both would let it through. It is kept because a
    // bare SHA is a legitimate, common startPoint value that must keep
    // working. The NEXT test (`'HEAD~1'`) is what genuinely proves the
    // distinction, since checkRefFormat rejects that valid commit-ish.
    it('checkout create:true with a bare-SHA startPoint succeeds', async () => {
      const dir = createTempRepo('git-branch-checkout-create-sha-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'first');
        const sha = headSha(dir);
        writeAndCommit(dir, 'a.txt', 'two\n', 'second');

        await service.checkout(dir, {
          branch: 'from-sha',
          create: true,
          startPoint: sha,
        });

        expect(currentBranch(dir)).toBe('from-sha');
        expect(headSha(dir)).toBe(sha);
      } finally {
        removeTempRepo(dir);
      }
    });

    // THE actual non-vacuous proof (see comment above): `check-ref-format
    // --branch` explicitly forbids '~' (confirmed against real git 2.43:
    // `git check-ref-format --branch 'HEAD~1'` exits 128), so a
    // startPoint of "HEAD~1" — an entirely ordinary "branch off one commit
    // back" request — fails immediately if checkRefFormat is ever applied
    // to startPoint, unlike the bare-SHA case above.
    it('checkout create:true with startPoint "HEAD~1" succeeds (checkRefFormat would reject this valid commit-ish)', async () => {
      const dir = createTempRepo('git-branch-checkout-create-head-tilde-');
      try {
        const firstSha = writeAndCommit(dir, 'a.txt', 'one\n', 'first');
        writeAndCommit(dir, 'a.txt', 'two\n', 'second');

        await service.checkout(dir, {
          branch: 'from-head-tilde',
          create: true,
          startPoint: 'HEAD~1',
        });

        expect(currentBranch(dir)).toBe('from-head-tilde');
        expect(headSha(dir)).toBe(firstSha);
      } finally {
        removeTempRepo(dir);
      }
    });

    for (const invalidName of ['..bad', '-flag']) {
      it(`rejects checkout to an invalid ref name (${JSON.stringify(invalidName)}) with INVALID_REF before any checkout call`, async () => {
        const dir = createTempRepo('git-branch-checkout-invalid-');
        const runSpy = jest.spyOn(GitRunner.prototype, 'run');
        try {
          writeAndCommit(dir, 'a.txt', 'one\n', 'initial');

          await expect(
            service.checkout(dir, { branch: invalidName }),
          ).rejects.toBeInstanceOf(BadRequestException);
          await expect(
            service.checkout(dir, { branch: invalidName }),
          ).rejects.toMatchObject({ response: { code: 'INVALID_REF' } });

          // Only check-ref-format's own internal run() call is allowed
          // through — never the actual `checkout` command.
          const commands = runSpy.mock.calls.map((call) => call[1][0]);
          expect(commands).not.toContain('checkout');
        } finally {
          runSpy.mockRestore();
          removeTempRepo(dir);
        }
      });
    }
  });

  describe('createBranch', () => {
    it('creates a branch without switching to it', async () => {
      const dir = createTempRepo('git-branch-create-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');

        await service.createBranch(dir, { name: 'feature' });

        expect(currentBranch(dir)).toBe('main');
        const branches = execFileSync('git', ['branch', '--list'], {
          cwd: dir,
        }).toString();
        expect(branches).toContain('feature');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('rejects creating with an invalid ref name (INVALID_REF) before any branch call', async () => {
      const dir = createTempRepo('git-branch-create-invalid-');
      const runSpy = jest.spyOn(GitRunner.prototype, 'run');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');

        await expect(
          service.createBranch(dir, { name: '-flag' }),
        ).rejects.toMatchObject({ response: { code: 'INVALID_REF' } });

        const commands = runSpy.mock.calls.map((call) => call[1][0]);
        expect(commands).not.toContain('branch');
      } finally {
        runSpy.mockRestore();
        removeTempRepo(dir);
      }
    });

    it('rejects with 409 BRANCH_EXISTS when the name already exists', async () => {
      const dir = createTempRepo('git-branch-create-exists-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        execFileSync('git', ['branch', 'dup'], { cwd: dir });

        await expect(
          service.createBranch(dir, { name: 'dup' }),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          service.createBranch(dir, { name: 'dup' }),
        ).rejects.toMatchObject({ response: { code: 'BRANCH_EXISTS' } });
      } finally {
        removeTempRepo(dir);
      }
    });
  });

  describe('deleteBranch', () => {
    it('rejects deleting an invalid ref name (INVALID_REF) before any branch call', async () => {
      const dir = createTempRepo('git-branch-delete-invalid-');
      const runSpy = jest.spyOn(GitRunner.prototype, 'run');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');

        await expect(
          service.deleteBranch(dir, { name: '..bad' }),
        ).rejects.toMatchObject({ response: { code: 'INVALID_REF' } });

        const commands = runSpy.mock.calls.map((call) => call[1][0]);
        expect(commands).not.toContain('branch');
      } finally {
        runSpy.mockRestore();
        removeTempRepo(dir);
      }
    });

    it('rejects with 404 BRANCH_NOT_FOUND for an unknown name', async () => {
      const dir = createTempRepo('git-branch-delete-unknown-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');

        await expect(
          service.deleteBranch(dir, { name: 'nope' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.deleteBranch(dir, { name: 'nope' }),
        ).rejects.toMatchObject({ response: { code: 'BRANCH_NOT_FOUND' } });
      } finally {
        removeTempRepo(dir);
      }
    });

    it('without force, refusing to delete an unmerged branch falls through as a plain GitCommandError with "not fully merged" in stderr', async () => {
      const dir = createTempRepo('git-branch-delete-unmerged-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        execFileSync('git', ['checkout', '-q', '-b', 'unmerged'], {
          cwd: dir,
        });
        writeAndCommit(dir, 'b.txt', 'two\n', 'unmerged commit');
        execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });

        await expect(
          service.deleteBranch(dir, { name: 'unmerged' }),
        ).rejects.toBeInstanceOf(GitCommandError);

        let caught: unknown;
        try {
          await service.deleteBranch(dir, { name: 'unmerged' });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(GitCommandError);
        expect((caught as GitCommandError).stderr).toContain(
          'not fully merged',
        );
      } finally {
        removeTempRepo(dir);
      }
    });

    it('force deletes an unmerged branch', async () => {
      const dir = createTempRepo('git-branch-delete-force-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        execFileSync('git', ['checkout', '-q', '-b', 'unmerged'], {
          cwd: dir,
        });
        writeAndCommit(dir, 'b.txt', 'two\n', 'unmerged commit');
        execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });

        await service.deleteBranch(dir, { name: 'unmerged', force: true });

        const branches = execFileSync('git', ['branch', '--list'], {
          cwd: dir,
        }).toString();
        expect(branches).not.toContain('unmerged');
      } finally {
        removeTempRepo(dir);
      }
    });
  });
});
