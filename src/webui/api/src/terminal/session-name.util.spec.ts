import { computeSessionName } from './session-name.util';

describe('computeSessionName', () => {
  it('is stable for the same inputs', () => {
    const a = computeSessionName('/workspace/repo', 'shell', 0);
    const b = computeSessionName('/workspace/repo', 'shell', 0);
    expect(a).toBe(b);
  });

  it('matches the wui-<12 hex chars> shape', () => {
    const name = computeSessionName('/workspace/repo', 'shell', 0);
    expect(name).toMatch(/^wui-[0-9a-f]{12}$/);
  });

  it('differs across cwd', () => {
    const a = computeSessionName('/workspace/repo-a', 'shell', 0);
    const b = computeSessionName('/workspace/repo-b', 'shell', 0);
    expect(a).not.toBe(b);
  });

  it('differs across mode', () => {
    const a = computeSessionName('/workspace/repo', 'shell', 0);
    const b = computeSessionName('/workspace/repo', 'claude', 0);
    expect(a).not.toBe(b);
  });

  it('differs across slot', () => {
    const a = computeSessionName('/workspace/repo', 'shell', 0);
    const b = computeSessionName('/workspace/repo', 'shell', 1);
    expect(a).not.toBe(b);
  });

  it('produces no path/./: characters that are special to tmux target names', () => {
    const name = computeSessionName('/workspace/repo', 'shell', 0);
    expect(name).not.toMatch(/[.:]/);
  });
});
