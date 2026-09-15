import { CLAUDE_LABEL_RE } from './terminal-label';

describe('CLAUDE_LABEL_RE', () => {
  it('accepts an alphanumeric-led label with allowed punctuation', () => {
    expect(CLAUDE_LABEL_RE.test('a')).toBe(true);
    expect(CLAUDE_LABEL_RE.test('my-task')).toBe(true);
    expect(CLAUDE_LABEL_RE.test('my_task.v2')).toBe(true);
    expect(CLAUDE_LABEL_RE.test('9lives')).toBe(true);
    expect(CLAUDE_LABEL_RE.test('a'.repeat(64))).toBe(true);
  });

  it('rejects a leading dash — the reason this validation exists at all', () => {
    // A leading dash would be parsed as a CLI flag by `claude
    // --remote-control <label>` on the server, not a session name.
    expect(CLAUDE_LABEL_RE.test('-dangerously-skip-permissions')).toBe(false);
  });

  it('rejects empty, too-long, and non-allowlisted-character labels', () => {
    expect(CLAUDE_LABEL_RE.test('')).toBe(false);
    expect(CLAUDE_LABEL_RE.test('a'.repeat(65))).toBe(false);
    expect(CLAUDE_LABEL_RE.test('has space')).toBe(false);
    expect(CLAUDE_LABEL_RE.test('has/slash')).toBe(false);
  });
});
