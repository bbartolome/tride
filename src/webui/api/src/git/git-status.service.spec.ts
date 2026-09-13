import { execFileSync } from 'child_process';
import {
  createAheadBehindFixture,
  createDetachedHeadFixture,
  createRenameStatusFixture,
  createTempRepo,
  removeAheadBehindFixture,
  removeTempRepo,
  writeAndCommit,
  type AheadBehindFixture,
} from './__fixtures__/git-repo-fixture';
import { GitRunner } from './git-runner.service';
import { GitStatusService } from './git-status.service';

describe('GitStatusService', () => {
  let service: GitStatusService;

  beforeEach(() => {
    service = new GitStatusService(new GitRunner());
  });

  it('reports a clean repo with no entries', async () => {
    const dir = createTempRepo('git-status-service-clean-');
    try {
      writeAndCommit(dir, 'a.txt', 'hello\n', 'initial');
      const result = await service.getStatus(dir);
      expect(result.branch).toBe('main');
      expect(result.detached).toBe(false);
      expect(result.upstream).toBeNull();
      expect(result.ahead).toBe(0);
      expect(result.behind).toBe(0);
      expect(result.entries).toEqual([]);
    } finally {
      removeTempRepo(dir);
    }
  });

  it('reports detached HEAD with branch:null, detached:true', async () => {
    const { dir } = createDetachedHeadFixture();
    try {
      const result = await service.getStatus(dir);
      expect(result.branch).toBeNull();
      expect(result.detached).toBe(true);
      expect(result.entries).toEqual([]);
    } finally {
      removeTempRepo(dir);
    }
  });

  it('reports both ahead and behind as nonzero via the bare-repo-as-remote pattern', async () => {
    let fixture: AheadBehindFixture | undefined;
    try {
      fixture = createAheadBehindFixture();
      const result = await service.getStatus(fixture.dir);
      expect(result.upstream).toBe('origin/main');
      expect(result.ahead).toBeGreaterThan(0);
      expect(result.behind).toBeGreaterThan(0);
    } finally {
      if (fixture) {
        removeAheadBehindFixture(fixture);
      }
    }
  });

  it('combines header and entries for a rename plus a trailing modification', async () => {
    const { dir } = createRenameStatusFixture();
    try {
      const result = await service.getStatus(dir);
      expect(result.entries).toHaveLength(2);
      const renamed = result.entries.find((e) => e.kind === 'renamed');
      expect(renamed).toMatchObject({ path: 'new.txt', origPath: 'old.txt' });
    } finally {
      removeTempRepo(dir);
    }
  });

  it('ground truth: matches independently-invoked `git status --porcelain=v2 --branch -z`', async () => {
    const { dir } = createRenameStatusFixture();
    try {
      const raw = execFileSync(
        'git',
        ['status', '--porcelain=v2', '--branch', '-z'],
        { cwd: dir },
      ).toString();

      const result = await service.getStatus(dir);

      // Independently walk the raw NUL-delimited stream (mirroring the
      // rename-consumes-an-extra-field rule, but without calling the
      // parser under test) and compare entry counts and the branch name
      // against what GitStatusService reported.
      const rawRecords = raw.split('\0').filter((r) => r.length > 0);
      let independentEntryCount = 0;
      let independentBranch: string | null = null;
      for (let i = 0; i < rawRecords.length; i++) {
        const record = rawRecords[i];
        if (record.startsWith('# branch.head ')) {
          const value = record.slice('# branch.head '.length);
          independentBranch = value === '(detached)' ? null : value;
          continue;
        }
        if (record.startsWith('#')) {
          continue;
        }
        independentEntryCount++;
        if (record.startsWith('2 ')) {
          i++; // skip the rename's separate origPath field
        }
      }

      expect(result.branch).toBe(independentBranch);
      expect(result.entries).toHaveLength(independentEntryCount);
      expect(
        result.entries.some(
          (e) => e.kind === 'renamed' && e.path === 'new.txt',
        ),
      ).toBe(true);
      expect(
        result.entries.some(
          (e) => e.kind === 'ordinary' && e.path === 'second.txt',
        ),
      ).toBe(true);
    } finally {
      removeTempRepo(dir);
    }
  });
});
