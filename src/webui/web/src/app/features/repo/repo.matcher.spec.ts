import { UrlSegment } from '@angular/router';
import { repoDiffMatcher, repoMatcher } from './repo.matcher';

function seg(path: string): UrlSegment {
  return new UrlSegment(path, {});
}

describe('repoMatcher', () => {
  it('does not match a bare /repo (a repo path can never be empty)', () => {
    expect(repoMatcher([seg('repo')])).toBeNull();
  });

  it('matches /repo/a', () => {
    const result = repoMatcher([seg('repo'), seg('a')]);
    expect(result?.posParams?.['repo'].path).toBe('a');
  });

  it('matches /repo/a/b/c, joining every remaining segment with "/"', () => {
    const result = repoMatcher([seg('repo'), seg('a'), seg('b'), seg('c')]);
    expect(result?.posParams?.['repo'].path).toBe('a/b/c');
  });

  it('does not match when the first segment is not "repo"', () => {
    expect(repoMatcher([seg('browse'), seg('a')])).toBeNull();
  });

  it('does not match an empty segment list', () => {
    expect(repoMatcher([])).toBeNull();
  });

  it('consumes every segment it is given', () => {
    const segments = [seg('repo'), seg('a'), seg('b')];
    const result = repoMatcher(segments);
    expect(result?.consumed).toBe(segments);
  });

  it('matches a repo path whose last segment is "diff" is left to the diff matcher, but repoMatcher alone still matches it fine', () => {
    // repoMatcher itself has no opinion on 'diff' — the ordering in
    // app.routes.ts (diff matcher first) is what keeps this from being a
    // problem in practice; verified in the ordering spec below.
    const result = repoMatcher([seg('repo'), seg('foo'), seg('diff')]);
    expect(result?.posParams?.['repo'].path).toBe('foo/diff');
  });
});

describe('repoDiffMatcher', () => {
  it('does not match /repo/a (no trailing "diff" segment)', () => {
    expect(repoDiffMatcher([seg('repo'), seg('a')])).toBeNull();
  });

  it('matches /repo/a/diff', () => {
    const result = repoDiffMatcher([seg('repo'), seg('a'), seg('diff')]);
    expect(result?.posParams?.['repo'].path).toBe('a');
  });

  it('matches /repo/a/b/diff, joining every segment between repo and diff', () => {
    const result = repoDiffMatcher([
      seg('repo'),
      seg('a'),
      seg('b'),
      seg('diff'),
    ]);
    expect(result?.posParams?.['repo'].path).toBe('a/b');
  });

  it('does not match when the first segment is not "repo"', () => {
    expect(repoDiffMatcher([seg('browse'), seg('a'), seg('diff')])).toBeNull();
  });

  it('does not match an empty or too-short segment list', () => {
    expect(repoDiffMatcher([])).toBeNull();
    expect(repoDiffMatcher([seg('repo'), seg('diff')])).toBeNull();
  });

  it('consumes every segment it is given', () => {
    const segments = [seg('repo'), seg('a'), seg('diff')];
    const result = repoDiffMatcher(segments);
    expect(result?.consumed).toBe(segments);
  });

  describe('ordering edge case (F159): a repo genuinely named "diff"', () => {
    it('/repo/foo/diff matches the diff matcher with repo: "foo"', () => {
      const result = repoDiffMatcher([seg('repo'), seg('foo'), seg('diff')]);
      expect(result).not.toBeNull();
      expect(result?.posParams?.['repo'].path).toBe('foo');
    });

    it('/repo/foo/diff/bar (diff not last) misses the diff matcher entirely, so it falls through to repoMatcher and resolves as repo: "foo/diff/bar"', () => {
      const segments = [seg('repo'), seg('foo'), seg('diff'), seg('bar')];
      expect(repoDiffMatcher(segments)).toBeNull();
      const fallback = repoMatcher(segments);
      expect(fallback?.posParams?.['repo'].path).toBe('foo/diff/bar');
    });

    it('a nested repo directory literally named "diff" (/repo/diff/diff) still resolves as repo: "diff" via the diff matcher', () => {
      const result = repoDiffMatcher([seg('repo'), seg('diff'), seg('diff')]);
      expect(result).not.toBeNull();
      expect(result?.posParams?.['repo'].path).toBe('diff');
    });
  });
});
