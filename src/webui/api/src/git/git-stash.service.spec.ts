import { BadRequestException, NotFoundException } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  createTempRepo,
  removeTempRepo,
  writeAndCommit,
} from './__fixtures__/git-repo-fixture';
import { GitRunner } from './git-runner.service';
import { GitStashService } from './git-stash.service';

function status(dir: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: dir })
    .toString()
    .trim();
}

describe('GitStashService', () => {
  let service: GitStashService;

  beforeEach(() => {
    service = new GitStashService(new GitRunner());
  });

  describe('push', () => {
    it('reverts a modified tracked file to a clean HEAD (verified via `git status --porcelain`)', async () => {
      const dir = createTempRepo('git-stash-push-');
      try {
        writeAndCommit(dir, 'a.txt', 'original\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'modified\n');
        expect(status(dir)).not.toBe('');

        await service.push(dir, {});

        expect(status(dir)).toBe('');
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original\n');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('with includeUntracked also stashes an untracked file, and pop restores it', async () => {
      const dir = createTempRepo('git-stash-push-untracked-');
      try {
        writeAndCommit(dir, 'a.txt', 'original\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'modified\n');
        const untrackedPath = join(dir, 'untracked.txt');
        writeFileSync(untrackedPath, 'junk\n');

        await service.push(dir, { includeUntracked: true });

        expect(status(dir)).toBe('');
        expect(existsSync(untrackedPath)).toBe(false);

        const list = await service.list(dir);
        expect(list).toHaveLength(1);

        await service.pop(dir, list[0].ref);

        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('modified\n');
        expect(existsSync(untrackedPath)).toBe(true);
        expect(readFileSync(untrackedPath, 'utf8')).toBe('junk\n');
        expect(await service.list(dir)).toHaveLength(0);
      } finally {
        removeTempRepo(dir);
      }
    });
  });

  describe('list', () => {
    it('returns an empty array when there are no stashes', async () => {
      const dir = createTempRepo('git-stash-list-empty-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        expect(await service.list(dir)).toEqual([]);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('shows one entry with correct ref/sha/date/message', async () => {
      const dir = createTempRepo('git-stash-list-one-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'two\n');
        await service.push(dir, { message: 'my stash message' });

        const expectedSha = execFileSync('git', ['rev-parse', 'refs/stash'], {
          cwd: dir,
        })
          .toString()
          .trim();

        const list = await service.list(dir);
        expect(list).toHaveLength(1);
        expect(list[0].ref).toBe('stash@{0}');
        expect(list[0].sha).toBe(expectedSha);
        expect(list[0].date).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
        );
        expect(list[0].message).toContain('my stash message');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('positionally parses a message containing a literal \\x1f delimiter without corrupting the field split', async () => {
      const dir = createTempRepo('git-stash-list-delim-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'two\n');
        const trickyMessage = 'has\x1fembedded\x1funit separators';
        await service.push(dir, { message: trickyMessage });

        const list = await service.list(dir);
        expect(list).toHaveLength(1);
        // git prefixes a plain `-m` message with "On <branch>: " — the
        // embedded \x1f bytes must survive that prefix intact, proving the
        // parser took only the first three delimiters as structural and
        // rejoined everything after with the same delimiter rather than
        // treating each \x1f as a new field boundary.
        expect(list[0].message).toBe(`On main: ${trickyMessage}`);
        // Sanity: ref/sha/date must still be well-formed, not swallowed
        // into the message by an under-splitting parser.
        expect(list[0].ref).toBe('stash@{0}');
        expect(list[0].sha).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('handles a message containing a raw newline without misreading it as a second stash entry', async () => {
      const dir = createTempRepo('git-stash-list-newline-');
      try {
        writeAndCommit(dir, 'a.txt', 'one\n', 'initial');

        writeFileSync(join(dir, 'a.txt'), 'two\n');
        await service.push(dir, {
          message: 'multi\nline stash message',
        });

        writeFileSync(join(dir, 'a.txt'), 'three\n');
        await service.push(dir, { message: 'second stash' });

        const list = await service.list(dir);
        // Exactly two entries — a raw newline inside the first message must
        // not be read by the `\n`-per-line list parse as a line boundary
        // that fabricates a third, phantom entry.
        expect(list).toHaveLength(2);
        expect(list[0].ref).toBe('stash@{0}');
        expect(list[0].message).toContain('second stash');
        expect(list[1].ref).toBe('stash@{1}');
        // git's own subject derivation flattens the embedded newline into a
        // space before it ever reaches our parser.
        expect(list[1].message).toBe('On main: multi line stash message');
      } finally {
        removeTempRepo(dir);
      }
    });
  });

  describe('apply / pop / drop', () => {
    it('pop restores the exact modification and removes the stash entry', async () => {
      const dir = createTempRepo('git-stash-pop-');
      try {
        writeAndCommit(dir, 'a.txt', 'original\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'modified\n');
        await service.push(dir, {});
        const [entry] = await service.list(dir);

        await service.pop(dir, entry.ref);

        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('modified\n');
        expect(await service.list(dir)).toEqual([]);
      } finally {
        removeTempRepo(dir);
      }
    });

    it('apply leaves the entry in place (list still shows it), unlike pop which removes it', async () => {
      const applyDir = createTempRepo('git-stash-apply-');
      const popDir = createTempRepo('git-stash-pop-vs-apply-');
      try {
        writeAndCommit(applyDir, 'a.txt', 'original\n', 'initial');
        writeFileSync(join(applyDir, 'a.txt'), 'modified\n');
        await service.push(applyDir, {});
        const [applyEntry] = await service.list(applyDir);

        await service.apply(applyDir, applyEntry.ref);

        expect(readFileSync(join(applyDir, 'a.txt'), 'utf8')).toBe(
          'modified\n',
        );
        // The explicit apply-vs-pop distinction: apply must NOT remove the
        // stash entry.
        expect(await service.list(applyDir)).toHaveLength(1);

        writeAndCommit(popDir, 'a.txt', 'original\n', 'initial');
        writeFileSync(join(popDir, 'a.txt'), 'modified\n');
        await service.push(popDir, {});
        const [popEntry] = await service.list(popDir);

        await service.pop(popDir, popEntry.ref);

        expect(await service.list(popDir)).toHaveLength(0);
      } finally {
        removeTempRepo(applyDir);
        removeTempRepo(popDir);
      }
    });

    it('drop removes an entry without applying it', async () => {
      const dir = createTempRepo('git-stash-drop-');
      try {
        writeAndCommit(dir, 'a.txt', 'original\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'modified\n');
        await service.push(dir, {});
        const [entry] = await service.list(dir);

        await service.drop(dir, entry.ref);

        expect(await service.list(dir)).toEqual([]);
        // The working tree must remain exactly as it was left after the
        // push (clean, at HEAD's content) — drop must never reapply.
        expect(status(dir)).toBe('');
        expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original\n');
      } finally {
        removeTempRepo(dir);
      }
    });

    it('stash@{5} against a short list -> 404 STASH_NOT_FOUND', async () => {
      const dir = createTempRepo('git-stash-not-found-short-');
      try {
        writeAndCommit(dir, 'a.txt', 'original\n', 'initial');
        writeFileSync(join(dir, 'a.txt'), 'modified\n');
        await service.push(dir, {});

        await expect(service.apply(dir, 'stash@{5}')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(service.apply(dir, 'stash@{5}')).rejects.toMatchObject({
          response: { code: 'STASH_NOT_FOUND' },
        });
      } finally {
        removeTempRepo(dir);
      }
    });

    it('stash@{0} against a completely empty list -> 404 STASH_NOT_FOUND', async () => {
      const dir = createTempRepo('git-stash-not-found-empty-');
      try {
        writeAndCommit(dir, 'a.txt', 'original\n', 'initial');

        await expect(service.drop(dir, 'stash@{0}')).rejects.toMatchObject({
          response: { code: 'STASH_NOT_FOUND' },
        });
      } finally {
        removeTempRepo(dir);
      }
    });

    for (const malformed of ['not-a-ref', 'stash@{-1}', 'stash@{0};rm -rf /']) {
      it(`rejects a malformed ref (${JSON.stringify(malformed)}) with 400 VALIDATION_ERROR before any git call`, async () => {
        const dir = createTempRepo('git-stash-malformed-');
        const runSpy = jest.spyOn(GitRunner.prototype, 'run');
        try {
          writeAndCommit(dir, 'a.txt', 'original\n', 'initial');

          await expect(service.apply(dir, malformed)).rejects.toBeInstanceOf(
            BadRequestException,
          );
          await expect(service.apply(dir, malformed)).rejects.toMatchObject({
            response: { code: 'VALIDATION_ERROR' },
          });

          expect(runSpy).not.toHaveBeenCalled();
        } finally {
          runSpy.mockRestore();
          removeTempRepo(dir);
        }
      });
    }
  });
});
