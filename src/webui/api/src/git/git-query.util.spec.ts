import { parseBoolFlag, parseIntParam } from './git-query.util';

describe('parseBoolFlag', () => {
  it('accepts only the conventional truthy forms', () => {
    expect(parseBoolFlag('1')).toBe(true);
    expect(parseBoolFlag('true')).toBe(true);
    expect(parseBoolFlag('TRUE')).toBe(true);
    expect(parseBoolFlag('0')).toBe(false);
    expect(parseBoolFlag('false')).toBe(false);
    expect(parseBoolFlag('')).toBe(false);
    expect(parseBoolFlag(undefined)).toBe(false);
  });
});

describe('parseIntParam', () => {
  it('falls back to the default for missing or garbage input', () => {
    expect(parseIntParam(undefined, 50, 200)).toBe(50);
    expect(parseIntParam('', 50, 200)).toBe(50);
    expect(parseIntParam('abc', 50, 200)).toBe(50);
  });

  it('clamps to the max', () => {
    expect(parseIntParam('9999', 50, 200)).toBe(200);
  });

  // Regression: min defaulted to 1 unconditionally, so an explicit ?skip=0
  // was floored to 1 and git log pagination silently dropped the newest
  // commit. Zero-based params must pass min: 0.
  it('honours an explicit zero when min is 0', () => {
    expect(parseIntParam('0', 0, 100, 0)).toBe(0);
  });

  it('still floors at 1 by default, for genuinely positive params', () => {
    expect(parseIntParam('0', 50, 200)).toBe(1);
    expect(parseIntParam('-5', 50, 200)).toBe(1);
  });

  // `git diff -U0` is valid and tighter than -U1, so context=0 must survive.
  it('preserves context=0 for a zero-min diff context', () => {
    expect(parseIntParam('0', 3, 100, 0)).toBe(0);
  });
});
