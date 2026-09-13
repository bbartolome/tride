import { ConflictException } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  createTempRepo,
  removeTempRepo,
  writeAndCommit,
} from './__fixtures__/git-repo-fixture';
import { GitChangesService } from './git-changes.service';
import { GitRunner } from './git-runner.service';

function headSha(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })
    .toString()
    .trim();
}

function commitCount(dir: string): number {
  return Number.parseInt(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })
      .toString()
      .trim(),
    10,
  );
}

function headMessage(dir: string): string {
  return execFileSync('git', ['log', '-1', '--format=%B'], { cwd: dir })
    .toString()
    .replace(/\n+$/, '');
}

describe('GitChangesService', () => {
  let service: GitChangesService;

  beforeEach(() => {
    service = new GitChangesService(new GitRunner());
  });

  describe('stage / unstage', () => {
    it('stages a given subset of paths, leaving the rest untouched', async () => {
      const dir = createTempRepo('git-changes-stage-subset-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'a\n');
        writeFileSync(join(dir, 'b.txt'), 'b\n');

        await service.stage(dir, { paths: ['a.txt'] });

        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: dir,
        }).toString();
        expect(status).toContain('A  a.txt');
        expect(status).toContain('?? b.txt');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('all:true stages everything with no pathspecs', async () => {
      const dir = createTempRepo('git-changes-stage-all-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'a\n');
        writeFileSync(join(dir, 'b.txt'), 'b\n');

        await service.stage(dir, { all: true });

        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: dir,
        }).toString();
        expect(status).toContain('A  a.txt');
        expect(status).toContain('A  b.txt');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('unstages a previously staged subset, leaving other staged paths staged', async () => {
      const dir = createTempRepo('git-changes-unstage-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'a\n');
        writeFileSync(join(dir, 'b.txt'), 'b\n');
        await service.stage(dir, { all: true });

        await service.unstage(dir, { paths: ['a.txt'] });

        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: dir,
        }).toString();
        expect(status).toContain('?? a.txt');
        expect(status).toContain('A  b.txt');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('unstage all:true unstages everything', async () => {
      const dir = createTempRepo('git-changes-unstage-all-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'a\n');
        writeFileSync(join(dir, 'b.txt'), 'b\n');
        await service.stage(dir, { all: true });

        await service.unstage(dir, { all: true });

        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: dir,
        }).toString();
        expect(status).toContain('?? a.txt');
        expect(status).toContain('?? b.txt');
      } finally {
        removeTempRepo(dir);
      }
    });
  });

  describe('discard', () => {
    // Regression: `git restore` validates every pathspec up front and aborts
    // the whole invocation if any one is untracked, so a mixed selection used
    // to restore NOTHING while clean still deleted the untracked members —
    // "discard these files" discarded some of them and reported success.
    // A mix of modified and new files is the ordinary case, not an edge case.
    it('reverts tracked files even when the same call names untracked ones', async () => {
      const dir = createTempRepo('git-changes-discard-mixed-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'original content\n', 'initial');
        writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
        writeFileSync(join(dir, 'untracked.txt'), 'brand new\n');

        await service.discard(dir, ['tracked.txt', 'untracked.txt']);

        expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe(
          'original content\n',
        );
        expect(existsSync(join(dir, 'untracked.txt'))).toBe(false);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('reverts a tracked modification to HEAD content, staged and unstaged', async () => {
      const dir = createTempRepo('git-changes-discard-revert-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'original content\n', 'initial');
        // Unstaged modification.
        writeFileSync(join(dir, 'tracked.txt'), 'modified unstaged\n');

        await service.discard(dir, ['tracked.txt']);

        // Assert the file's content ON DISK matches HEAD, not just that the
        // call resolved without throwing.
        const onDisk = readFileSync(join(dir, 'tracked.txt'), 'utf8');
        expect(onDisk).toBe('original content\n');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('reverts a STAGED tracked modification too (--worktree --staged both)', async () => {
      const dir = createTempRepo('git-changes-discard-staged-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'original content\n', 'initial');
        writeFileSync(join(dir, 'tracked.txt'), 'modified and staged\n');
        execFileSync('git', ['add', '--', 'tracked.txt'], { cwd: dir });

        await service.discard(dir, ['tracked.txt']);

        const onDisk = readFileSync(join(dir, 'tracked.txt'), 'utf8');
        expect(onDisk).toBe('original content\n');
        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: dir,
        }).toString();
        expect(status.trim()).toBe('');
      } finally {
        removeTempRepo(dir);
      }
    });

    // THE SCOPING PROOF (F-critical for this task): `clean -fd` is the most
    // dangerous single call in the codebase, and pathspec-scoping is the
    // only thing standing between "remove untracked junk the user selected"
    // and "wipe every untracked file/dir in the repo". This test is
    // deliberately explicit about what lies inside vs. outside the given
    // paths.
    it('removes an untracked file and an untracked directory within the given paths, while an untracked file OUTSIDE those paths survives', async () => {
      const dir = createTempRepo('git-changes-discard-scoping-');
      try {
        writeAndCommit(dir, 'tracked.txt', 'kept\n', 'initial');

        const scopedFile = join(dir, 'scoped-untracked.txt');
        writeFileSync(scopedFile, 'scoped junk\n');

        const scopedDir = join(dir, 'scoped-dir');
        mkdirSync(scopedDir);
        writeFileSync(join(scopedDir, 'inner.txt'), 'inner junk\n');

        const outsideFile = join(dir, 'outside-untracked.txt');
        writeFileSync(outsideFile, 'must survive\n');

        await service.discard(dir, ['scoped-untracked.txt', 'scoped-dir']);

        expect(existsSync(scopedFile)).toBe(false);
        expect(existsSync(scopedDir)).toBe(false);
        // The scoping proof: an untracked file NOT named in `paths` must
        // never be touched by `clean -fd`.
        expect(existsSync(outsideFile)).toBe(true);
        expect(readFileSync(outsideFile, 'utf8')).toBe('must survive\n');
      } finally {
        removeTempRepo(dir);
      }
    });
  });

  describe('commit', () => {
    it('creates a new commit — HEAD sha changes and matches the returned sha', async () => {
      const dir = createTempRepo('git-changes-commit-happy-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        const shaBefore = headSha(dir);

        writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
        await service.stage(dir, { all: true });

        const result = await service.commit(dir, { message: 'second commit' });

        const shaAfter = headSha(dir);
        expect(shaAfter).not.toBe(shaBefore);
        expect(result.sha).toBe(shaAfter);
        expect(headMessage(dir)).toBe('second commit');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('amend replaces the message without changing history length', async () => {
      const dir = createTempRepo('git-changes-commit-amend-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        writeAndCommit(dir, 'b.txt', 'two\n', 'original message');
        const countBefore = commitCount(dir);

        await service.commit(dir, { message: 'amended message', amend: true });

        expect(commitCount(dir)).toBe(countBefore);
        expect(headMessage(dir)).toBe('amended message');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('signoff appends a Signed-off-by trailer', async () => {
      const dir = createTempRepo('git-changes-commit-signoff-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
        await service.stage(dir, { all: true });

        await service.commit(dir, { message: 'signed commit', signoff: true });

        expect(headMessage(dir)).toContain('Signed-off-by:');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('rejects with 409 NOTHING_TO_COMMIT on a clean tree', async () => {
      const dir = createTempRepo('git-changes-commit-nothing-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');

        await expect(
          service.commit(dir, { message: 'no-op commit' }),
        ).rejects.toMatchObject({
          response: { code: 'NOTHING_TO_COMMIT' },
        });
        await expect(
          service.commit(dir, { message: 'no-op commit' }),
        ).rejects.toBeInstanceOf(ConflictException);
      } finally {
        removeTempRepo(dir);
      }
    });

    // Proves the deliberate absence of `assertNotOptionLike` on `-m`'s
    // value: `message` occupies `-m`'s option-value slot, so git's argument
    // parser cannot reinterpret a leading "-" as a flag, regardless of what
    // the guard covering positional pathspecs/revs would otherwise reject.
    it('accepts a commit message beginning with "-"', async () => {
      const dir = createTempRepo('git-changes-commit-leading-dash-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
        await service.stage(dir, { all: true });

        const message = '-fix: leading dash';
        await service.commit(dir, { message });

        expect(headMessage(dir)).toBe(message);
      } finally {
        removeTempRepo(dir);
      }
    });
  });
});
