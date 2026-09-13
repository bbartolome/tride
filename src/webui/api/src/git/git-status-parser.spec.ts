import { execFileSync } from 'child_process';
import {
  createMergeConflictFixture,
  createRenameStatusFixture,
  createUntrackedDirectoryFixture,
  removeTempRepo,
} from './__fixtures__/git-repo-fixture';
import {
  GitStatusEntry,
  parseGitStatusEntries,
  parseGitStatusHeader,
  RenamedStatusEntry,
} from './git-status-parser';

/** Builds a raw `-z` porcelain v2 stream from plain-text records. */
function records(...lines: string[]): string {
  return lines.map((line) => `${line}\0`).join('');
}

/** Runs real `git status --porcelain=v2 --branch -z` against `dir`. */
function rawStatus(dir: string): string {
  return execFileSync('git', ['status', '--porcelain=v2', '--branch', '-z'], {
    cwd: dir,
  }).toString();
}

describe('parseGitStatusHeader', () => {
  it('parses a clean branch with no upstream', () => {
    const raw = records(
      '# branch.oid 117ca999860a96b189c1adc79bfb4e83ef06b2d7',
      '# branch.head main',
    );
    expect(parseGitStatusHeader(raw)).toEqual({
      branch: 'main',
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: false,
    });
  });

  it('parses upstream and ahead/behind counts', () => {
    const raw = records(
      '# branch.oid 5310e49e2c2f7462f30e1df5e4d1f13c84f74ae6',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
    );
    const header = parseGitStatusHeader(raw);
    expect(header.branch).toBe('main');
    expect(header.upstream).toBe('origin/main');
    expect(header.ahead).toBe(2);
    expect(header.behind).toBe(3);
    expect(header.dirty).toBe(false);
  });

  it('marks detached HEAD with a null branch', () => {
    const raw = records(
      '# branch.oid 5310e49e2c2f7462f30e1df5e4d1f13c84f74ae6',
      '# branch.head (detached)',
    );
    const header = parseGitStatusHeader(raw);
    expect(header.detached).toBe(true);
    expect(header.branch).toBeNull();
  });

  it('handles the no-commits-yet "(initial)" oid without affecting branch parsing', () => {
    const raw = records('# branch.oid (initial)', '# branch.head main');
    expect(parseGitStatusHeader(raw).branch).toBe('main');
  });

  it('sets dirty:true when any non-header record is present', () => {
    const raw = records(
      '# branch.oid 117ca999860a96b189c1adc79bfb4e83ef06b2d7',
      '# branch.head main',
      '1 .M N... 100644 100644 100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 a.txt',
    );
    expect(parseGitStatusHeader(raw).dirty).toBe(true);
  });

  it('sets dirty:true for an untracked-only entry', () => {
    const raw = records(
      '# branch.oid (initial)',
      '# branch.head main',
      '? untracked.txt',
    );
    expect(parseGitStatusHeader(raw).dirty).toBe(true);
  });

  it('leaves dirty:false when only header records are present', () => {
    const raw = records(
      '# branch.oid 117ca999860a96b189c1adc79bfb4e83ef06b2d7',
      '# branch.head main',
    );
    expect(parseGitStatusHeader(raw).dirty).toBe(false);
  });

  it('returns all-default values for an empty string', () => {
    expect(parseGitStatusHeader('')).toEqual({
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: false,
    });
  });
});

describe('parseGitStatusEntries', () => {
  it('returns an empty array for a clean repo (header records only)', () => {
    const raw = records(
      '# branch.oid 117ca999860a96b189c1adc79bfb4e83ef06b2d7',
      '# branch.head main',
    );
    expect(parseGitStatusEntries(raw)).toEqual([]);
  });

  it('parses a file staged AND unstaged-modified as one ordinary entry with both flags set', () => {
    const raw = records(
      '# branch.head main',
      '1 MM N... 100644 100644 100644 aaaaaaa1 bbbbbbb2 a.txt',
    );
    expect(parseGitStatusEntries(raw)).toEqual([
      { kind: 'ordinary', path: 'a.txt', staged: true, unstaged: true },
    ]);
  });

  it('parses a newly staged file (index-only change) with staged:true, unstaged:false', () => {
    const raw = records(
      '# branch.head main',
      '1 A. N... 000000 100644 100644 0000000 ccccccc3 new-file.txt',
    );
    expect(parseGitStatusEntries(raw)).toEqual([
      {
        kind: 'ordinary',
        path: 'new-file.txt',
        staged: true,
        unstaged: false,
      },
    ]);
  });

  it('parses a deleted-but-not-staged tracked file with staged:false, unstaged:true', () => {
    const raw = records(
      '# branch.head main',
      '1 .D N... 100644 100644 100644 ddddddd4 ddddddd4 gone.txt',
    );
    expect(parseGitStatusEntries(raw)).toEqual([
      { kind: 'ordinary', path: 'gone.txt', staged: false, unstaged: true },
    ]);
  });

  it('positionally isolates a rename desync regardless of what the origPath happens to look like', () => {
    // Deliberately engineered origPath ("?collide.txt") that itself looks
    // like a valid record marker ('?' = untracked). If the cursor fails to
    // consume it as the rename's origPath field, the next loop iteration
    // visits it as its own bogus record, INSERTING a phantom entry between
    // the rename and the real next record — desyncing every position after
    // the rename, not just corrupting the rename's own origPath value.
    const raw = records(
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaaaaaa1 bbbbbbb2 R100 new.txt',
      '?collide.txt',
      '1 .M N... 100644 100644 100644 ccccccc3 ddddddd4 second.txt',
    );

    const entries = parseGitStatusEntries(raw);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      kind: 'renamed',
      path: 'new.txt',
      origPath: '?collide.txt',
      score: 100,
      staged: true,
      unstaged: false,
    });
    // Positional check (not `.find()`) — this is what actually catches a
    // desync: `.find()` would still locate `second.txt` correctly even if
    // a phantom entry were wrongly inserted at index 1.
    expect(entries[1]).toEqual({
      kind: 'ordinary',
      path: 'second.txt',
      staged: false,
      unstaged: true,
    });
  });

  describe('rename desync regression (real git output)', () => {
    let dir: string;

    beforeEach(() => {
      dir = createRenameStatusFixture().dir;
    });

    afterEach(() => {
      removeTempRepo(dir);
    });

    it('parses the rename with its origPath AND correctly parses the record after it', () => {
      const entries = parseGitStatusEntries(rawStatus(dir));

      const renamed = entries.find(
        (e): e is RenamedStatusEntry => e.kind === 'renamed',
      );
      expect(renamed).toBeDefined();
      expect(renamed?.path).toBe('new.txt');
      expect(renamed?.origPath).toBe('old.txt');
      expect(renamed?.score).toBe(100);
      expect(renamed?.staged).toBe(true);

      // The record for `second.txt` comes right after the rename record in
      // git's own (path-sorted) output. If the cursor failed to consume
      // the rename's extra origPath field, this record would desync and
      // either go missing or be misparsed (e.g. picking up "old.txt" as
      // its path instead of "second.txt").
      const second = entries.find((e) => e.kind === 'ordinary');
      expect(second).toBeDefined();
      expect(second?.path).toBe('second.txt');
      expect(second?.staged).toBe(false);
      expect(second?.unstaged).toBe(true);

      // Exactly these two entries — nothing extra, nothing swallowed.
      expect(entries).toHaveLength(2);
    });
  });

  describe('merge conflict (real git output)', () => {
    let dir: string;

    beforeEach(() => {
      dir = createMergeConflictFixture().dir;
    });

    afterEach(() => {
      removeTempRepo(dir);
    });

    it('reports the conflicted path as an unmerged entry', () => {
      const entries = parseGitStatusEntries(rawStatus(dir));
      const unmerged = entries.find((e) => e.kind === 'unmerged');
      expect(unmerged).toBeDefined();
      expect(unmerged?.path).toBe('conflict.txt');
    });
  });

  describe('untracked directory (real git output)', () => {
    let dir: string;

    beforeEach(() => {
      dir = createUntrackedDirectoryFixture().dir;
    });

    afterEach(() => {
      removeTempRepo(dir);
    });

    it('reports the directory itself, not its contents, with isDirectory:true', () => {
      const entries = parseGitStatusEntries(rawStatus(dir));
      const untracked = entries.filter(
        (e): e is GitStatusEntry & { kind: 'untracked' } =>
          e.kind === 'untracked',
      );
      expect(untracked).toHaveLength(1);
      expect(untracked[0]).toEqual({
        kind: 'untracked',
        path: 'newdir',
        isDirectory: true,
      });
    });
  });
});
