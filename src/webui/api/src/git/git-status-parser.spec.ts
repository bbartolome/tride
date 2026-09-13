import { parseGitStatusHeader } from './git-status-parser';

/** Builds a raw `-z` porcelain v2 stream from plain-text records. */
function records(...lines: string[]): string {
  return lines.map((line) => `${line}\0`).join('');
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
