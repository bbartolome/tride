import { UrlSegment } from '@angular/router';
import { browseMatcher } from './browse.matcher';

function seg(path: string): UrlSegment {
  return new UrlSegment(path, {});
}

describe('browseMatcher', () => {
  it('matches bare /browse as the workspace root (path: "")', () => {
    const result = browseMatcher([seg('browse')]);
    expect(result).not.toBeNull();
    expect(result?.posParams?.['path'].path).toBe('');
  });

  it('matches /browse/a', () => {
    const result = browseMatcher([seg('browse'), seg('a')]);
    expect(result?.posParams?.['path'].path).toBe('a');
  });

  it('matches /browse/a/b/c, joining every remaining segment with "/"', () => {
    const result = browseMatcher([
      seg('browse'),
      seg('a'),
      seg('b'),
      seg('c'),
    ]);
    expect(result?.posParams?.['path'].path).toBe('a/b/c');
  });

  it('does not match when the first segment is not "browse"', () => {
    expect(browseMatcher([seg('repo'), seg('a')])).toBeNull();
  });

  it('does not match an empty segment list', () => {
    expect(browseMatcher([])).toBeNull();
  });

  it('consumes every segment it is given', () => {
    const segments = [seg('browse'), seg('a'), seg('b')];
    const result = browseMatcher(segments);
    expect(result?.consumed).toBe(segments);
  });
});
