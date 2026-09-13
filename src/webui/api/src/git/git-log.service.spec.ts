import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  createMultiCommitHistoryFixture,
  createTempRepo,
  removeTempRepo,
  writeAndCommit,
} from './__fixtures__/git-repo-fixture';
import { GitLogService } from './git-log.service';
import { GitRunner } from './git-runner.service';

describe('GitLogService', () => {
  let service: GitLogService;

  beforeEach(() => {
    service = new GitLogService(new GitRunner());
  });

  describe('show', () => {
    it('returns the header and diff of a specific commit', async () => {
      const dir = createTempRepo('git-show-basic-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'first commit');
        writeAndCommit(dir, 'b.txt', 'unrelated\n', 'second commit');
        const sha = writeAndCommit(
          dir,
          'a.txt',
          'one\nmodified\n',
          'third commit',
        );

        const result = await service.show(dir, sha);

        expect(result.header.sha).toBe(sha);
        expect(result.header.author).toBe('Fixture User');
        expect(result.header.email).toBe('fixture@example.com');
        expect(result.header.message).toBe('third commit');
        expect(result.diffText).toContain('diff --git a/a.txt b/a.txt');
        expect(result.diffText).toContain('+modified');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('a path filter restricts the diff to that path and excludes other files changed in the same commit', async () => {
      const dir = createTempRepo('git-show-path-filter-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'first commit');
        writeAndCommit(dir, 'b.txt', 'one\n', 'second commit');
        writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
        writeFileSync(join(dir, 'b.txt'), 'one\ntwo\n');
        execFileSync('git', ['add', '-A'], { cwd: dir });
        execFileSync('git', ['commit', '--quiet', '-m', 'touch both'], {
          cwd: dir,
        });
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })
          .toString()
          .trim();

        const full = await service.show(dir, sha);
        expect(full.diffText).toContain('a/a.txt');
        expect(full.diffText).toContain('a/b.txt');

        const scoped = await service.show(dir, sha, 'a.txt');
        expect(scoped.diffText).toContain('a/a.txt');
        expect(scoped.diffText).not.toContain('a/b.txt');
        // The header must be identical regardless of the path filter.
        expect(scoped.header).toEqual(full.header);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('accepts a bare SHA as rev (proves checkRefFormat is NOT applied)', async () => {
      const dir = createTempRepo('git-show-bare-sha-');
      try {
        const sha = writeAndCommit(dir, 'a.txt', 'one\n', 'only commit');
        // `check-ref-format --branch` rejects some strings that are
        // perfectly valid commit-ish expressions; a bare SHA must still
        // work here, which it would not if `show` mistakenly ran `rev`
        // through `checkRefFormat` (F59) before reaching git.
        const result = await service.show(dir, sha);
        expect(result.header.sha).toBe(sha);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('preserves a multi-line body and embedded \\x1f / \\x1e bytes in the commit message', async () => {
      const dir = createTempRepo('git-show-delimiter-message-');
      try {
        const message =
          'Subject line\n\nBody line one\nBody line two with \x1f embedded US\n' +
          'Another line with \x1e embedded RS\nFinal body line';
        const sha = writeAndCommit(dir, 'a.txt', 'content\n', message);

        const result = await service.show(dir, sha);

        expect(result.header.message).toBe(message);
        expect(result.header.sha).toBe(sha);
        // The diff must not have been corrupted by the embedded delimiter
        // bytes either — this is the case that would break under the
        // plan's literal (non -z) command, since a naive "split on the
        // first \x1e" lands on the EMBEDDED one instead of our own
        // terminator.
        expect(result.diffText).toContain('diff --git a/a.txt b/a.txt');
        expect(result.diffText).not.toContain('\x1f');
        expect(result.diffText).not.toContain('\x1e');
      } finally {
        removeTempRepo(dir);
      }
    });
  });

  describe('log', () => {
    it('paginates with limit and skip against a 5-commit history', async () => {
      const { dir, shas } = createMultiCommitHistoryFixture();
      try {
        const firstPage = await service.log(dir, { limit: 2, skip: 0 });
        expect(firstPage.map((e) => e.sha)).toEqual([shas[4], shas[3]]);

        const secondPage = await service.log(dir, { limit: 2, skip: 2 });
        expect(secondPage.map((e) => e.sha)).toEqual([shas[2], shas[1]]);

        const thirdPage = await service.log(dir, { limit: 2, skip: 4 });
        expect(thirdPage.map((e) => e.sha)).toEqual([shas[0]]);

        const all = await service.log(dir, { limit: 50, skip: 0 });
        expect(all).toHaveLength(5);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('scopes log to a path, returning only the commits that touched it', async () => {
      const { dir, shas } = createMultiCommitHistoryFixture();
      try {
        const scoped = await service.log(dir, {
          limit: 50,
          skip: 0,
          path: 'scoped.txt',
        });
        expect(scoped.map((e) => e.sha)).toEqual([shas[3], shas[1]]);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('preserves a multi-line body and embedded delimiter bytes across multiple log entries', async () => {
      const dir = createTempRepo('git-log-delimiter-message-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'plain first commit');
        const trickyMessage =
          'Weird subject\n\nLine with \x1f US and \x1e RS embedded\nlast line';
        const sha2 = writeAndCommit(dir, 'a.txt', 'two\n', trickyMessage);
        const sha3 = writeAndCommit(
          dir,
          'a.txt',
          'three\n',
          'plain last commit',
        );

        const entries = await service.log(dir, { limit: 10, skip: 0 });

        expect(entries).toHaveLength(3);
        expect(entries[0].sha).toBe(sha3);
        expect(entries[0].message).toBe('plain last commit');
        expect(entries[1].sha).toBe(sha2);
        expect(entries[1].message).toBe(trickyMessage);
        // The entry positioned after the tricky one must not have been
        // corrupted by it.
        expect(entries[2].message).toBe('plain first commit');
      } finally {
        removeTempRepo(dir);
      }
    });
  });
});
