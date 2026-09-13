import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  createDiffSummaryFixture,
  createTempRepo,
  removeTempRepo,
  writeAndCommit,
} from './__fixtures__/git-repo-fixture';
import {
  DiffSummaryEntry,
  GitDiffService,
  parseNumstatZ,
} from './git-diff.service';
import { GitRunner } from './git-runner.service';

/** Builds a raw `-z`-terminated stream from plain-text tokens. */
function nulTokens(...tokens: string[]): string {
  return tokens.map((t) => `${t}\0`).join('');
}

describe('parseNumstatZ (pure parser)', () => {
  it('parses ordinary added/deleted records', () => {
    const raw = nulTokens('3\t1\ta.txt', '0\t5\tb.txt');
    expect(parseNumstatZ(raw)).toEqual([
      { path: 'a.txt', added: 3, deleted: 1, binary: false },
      { path: 'b.txt', added: 0, deleted: 5, binary: false },
    ]);
  });

  it('parses a binary record with null added/deleted', () => {
    const raw = nulTokens('-\t-\tbin.dat');
    expect(parseNumstatZ(raw)).toEqual([
      { path: 'bin.dat', added: null, deleted: null, binary: true },
    ]);
  });

  it(
    'positionally isolates a rename desync regardless of what the new path ' +
      'happens to look like',
    () => {
      // Deliberately engineered new-path ("1\t1\tdecoy.txt") that itself
      // looks exactly like a valid, unrelated numstat record. If the cursor
      // fails to consume it as the rename's second extra field, the next
      // loop iteration visits it as its own record — and because it
      // matches the generic <added>\t<deleted>\t<path> shape, that phantom
      // entry looks entirely plausible rather than obviously broken,
      // silently displacing the real record that should follow the rename.
      const raw = nulTokens(
        '0\t0\t', // rename meta: empty path field
        'old.txt', // origPath
        '1\t1\tdecoy.txt', // new path — the engineered collision
        '2\t0\tthird.txt', // the real record after the rename
      );

      const entries = parseNumstatZ(raw);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        path: '1\t1\tdecoy.txt',
        origPath: 'old.txt',
        added: 0,
        deleted: 0,
        binary: false,
      });
      // The record positioned after the rename must be the real third.txt
      // entry, not the phantom "decoy.txt" a desynced cursor would
      // manufacture from the rename's own new-path field.
      expect(entries[1]).toEqual({
        path: 'third.txt',
        added: 2,
        deleted: 0,
        binary: false,
      });
    },
  );
});

describe('GitDiffService', () => {
  let service: GitDiffService;

  beforeEach(() => {
    service = new GitDiffService(new GitRunner());
  });

  it('diff() reports different output for staged vs unstaged changes to the same file', async () => {
    const dir = createTempRepo('git-diff-staged-vs-unstaged-');
    try {
      writeAndCommit(dir, 'a.txt', 'one\ntwo\nthree\n', 'initial');
      writeFileSync(join(dir, 'a.txt'), 'one\nTWO-STAGED\nthree\n');
      // stage it, then make a further, different, UNstaged change
      execFileSync('git', ['add', '--', 'a.txt'], { cwd: dir });
      writeFileSync(
        join(dir, 'a.txt'),
        'one\nTWO-STAGED\nthree\nFOUR-UNSTAGED\n',
      );

      const staged = await service.diff(dir, {
        staged: true,
        context: 3,
        path: 'a.txt',
      });
      const unstaged = await service.diff(dir, {
        staged: false,
        context: 3,
        path: 'a.txt',
      });

      // `git diff --staged` compares HEAD -> index, so it shows TWO-STAGED
      // as an ADDED line and never mentions FOUR-UNSTAGED (index doesn't
      // have it yet). `git diff` (unstaged) compares index -> worktree, so
      // TWO-STAGED is already on the "old" side (a context line, not an
      // addition) and only FOUR-UNSTAGED shows up as added.
      expect('text' in staged && staged.text).toContain('+TWO-STAGED');
      expect('text' in staged && staged.text).not.toContain('FOUR-UNSTAGED');
      expect('text' in unstaged && unstaged.text).toContain('+FOUR-UNSTAGED');
      expect('text' in unstaged && unstaged.text).not.toContain('+TWO-STAGED');
      expect(staged).not.toEqual(unstaged);
    } finally {
      removeTempRepo(dir);
    }
  });

  it('diff() context option changes the number of surrounding context lines shown', async () => {
    const dir = createTempRepo('git-diff-context-');
    try {
      const lines = Array.from({ length: 21 }, (_, i) => `line${i + 1}`);
      writeAndCommit(dir, 'f.txt', lines.join('\n') + '\n', 'initial');
      lines[10] = 'CHANGED';
      writeFileSync(join(dir, 'f.txt'), lines.join('\n') + '\n');

      const narrow = await service.diff(dir, {
        staged: false,
        context: 1,
        path: 'f.txt',
      });
      const wide = await service.diff(dir, {
        staged: false,
        context: 8,
        path: 'f.txt',
      });

      const narrowText = 'text' in narrow ? narrow.text : '';
      const wideText = 'text' in wide ? wide.text : '';
      expect(wideText.split('\n').length).toBeGreaterThan(
        narrowText.split('\n').length,
      );
    } finally {
      removeTempRepo(dir);
    }
  });

  it('diff() detects a binary file and returns {binary:true} without diff text', async () => {
    const dir = createTempRepo('git-diff-binary-');
    try {
      writeAndCommit(dir, 'placeholder.txt', 'x\n', 'initial');
      writeFileSync(
        join(dir, 'bin.dat'),
        Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
      );
      execFileSync('git', ['add', '--', 'bin.dat'], { cwd: dir });

      const result = await service.diff(dir, {
        staged: true,
        context: 3,
        path: 'bin.dat',
      });

      expect(result).toEqual({ binary: true });
    } finally {
      removeTempRepo(dir);
    }
  });

  it(
    'diffSummary() across a binary file, an engineered-collision rename, and ' +
      'an ordinary modification reports every record correctly positioned',
    async () => {
      const { dir } = createDiffSummaryFixture();
      try {
        const summary = await service.diffSummary(dir, { staged: true });

        expect(summary).toHaveLength(3);

        const renamed = summary.find((e) => e.origPath !== undefined);
        expect(renamed).toEqual({
          path: '1\t1\tdecoy.txt',
          origPath: 'old.txt',
          added: 0,
          deleted: 0,
          binary: false,
        } satisfies DiffSummaryEntry);

        const binaryEntry = summary.find((e) => e.binary);
        expect(binaryEntry).toMatchObject({
          path: 'bin.dat',
          added: null,
          deleted: null,
          binary: true,
        });

        const ordinary = summary.find(
          (e) => e.path === 'third.txt' && !e.binary,
        );
        expect(ordinary).toEqual({
          path: 'third.txt',
          added: 1,
          deleted: 0,
          binary: false,
        });

        // Ground truth: real git emits rename, then binary, then ordinary,
        // in that order — assert the record positioned right after the
        // rename specifically (not just "exists somewhere"), since that is
        // exactly the position a desynced cursor would corrupt.
        expect(summary[0].origPath).toBe('old.txt');
        expect(summary[1]).toMatchObject({ path: 'bin.dat', binary: true });
      } finally {
        removeTempRepo(dir);
      }
    },
  );
});
