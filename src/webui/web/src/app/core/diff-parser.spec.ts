import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiff } from './diff-parser';

/**
 * Fixtures for this file are REAL `git diff` output from an actual git
 * repo in a temp dir (`git init`, commit, modify, `git diff`) — not
 * hand-written diff text. Hand-written fixtures tend to encode the
 * author's assumptions about diff format rather than what git actually
 * emits (F70/F71: this is exactly the class of bug real git output
 * exposes and hand-written text does not, e.g. the rename double-field
 * shape).
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  // Isolate from any real user gitconfig (gpgsign, pager, color, editor).
  HOME: '',
};

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...GIT_ENV, HOME: dir },
  });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-parser-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.pager', 'cat']);
  return dir;
}

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function diff(dir: string, args: string[] = []): string {
  // --no-color: belt-and-suspenders on top of the non-tty auto-detection.
  return git(dir, ['diff', '--no-color', ...args]);
}

const dirs: string[] = [];

function repo(): string {
  const dir = initRepo();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('parseUnifiedDiff', () => {
  it('parses a modified file with multiple hunks', () => {
    const dir = repo();
    // 20 lines, far enough apart (> 2*3 context) that two edits produce
    // two separate hunks rather than merging into one.
    const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    write(dir, 'multi.txt', original.join('\n') + '\n');
    git(dir, ['add', 'multi.txt']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    const modified = [...original];
    modified[1] = 'line 2 CHANGED';
    modified[17] = 'line 18 CHANGED';
    write(dir, 'multi.txt', modified.join('\n') + '\n');

    const hunks = parseUnifiedDiff(diff(dir));

    expect(hunks.length).toBe(2);
    for (const hunk of hunks) {
      expect(hunk.header.startsWith('@@')).toBe(true);
    }
    expect(hunks[0].lines.some((l) => l.type === 'del' && l.text === 'line 2')).toBe(true);
    expect(
      hunks[0].lines.some((l) => l.type === 'add' && l.text === 'line 2 CHANGED'),
    ).toBe(true);
    expect(
      hunks[1].lines.some((l) => l.type === 'del' && l.text === 'line 18'),
    ).toBe(true);
    expect(
      hunks[1].lines.some((l) => l.type === 'add' && l.text === 'line 18 CHANGED'),
    ).toBe(true);
    // Unchanged surrounding lines still show up as context.
    expect(hunks[0].lines.some((l) => l.type === 'context')).toBe(true);
  });

  it('parses an added file as a single hunk of all-add lines', () => {
    const dir = repo();
    write(dir, 'base.txt', 'x\n');
    git(dir, ['add', 'base.txt']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    write(dir, 'new.txt', 'hello\nworld\n');
    git(dir, ['add', 'new.txt']);

    const hunks = parseUnifiedDiff(diff(dir, ['--cached', '--', 'new.txt']));

    expect(hunks.length).toBe(1);
    expect(hunks[0].lines.every((l) => l.type === 'add')).toBe(true);
    expect(hunks[0].lines.map((l) => l.text)).toEqual(['hello', 'world']);
  });

  it('parses a deleted file as a single hunk of all-del lines', () => {
    const dir = repo();
    write(dir, 'gone.txt', 'a\nb\nc\n');
    git(dir, ['add', 'gone.txt']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    git(dir, ['rm', '-q', 'gone.txt']);

    const hunks = parseUnifiedDiff(diff(dir, ['--cached', '--', 'gone.txt']));

    expect(hunks.length).toBe(1);
    expect(hunks[0].lines.every((l) => l.type === 'del')).toBe(true);
    expect(hunks[0].lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('parses a pure rename (git mv, no content change) as zero hunks', () => {
    const dir = repo();
    write(dir, 'old.txt', 'unchanged content\nsecond line\n');
    git(dir, ['add', 'old.txt']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    git(dir, ['mv', 'old.txt', 'renamed.txt']);

    const hunks = parseUnifiedDiff(diff(dir, ['--cached', '-M']));

    // 100% similarity: git emits the rename header but no @@ hunks at
    // all — this must parse to [], not throw or fabricate a hunk out of
    // the "rename from"/"rename to" preamble lines.
    expect(hunks).toEqual([]);
  });

  it('parses a rename WITH a content change: preamble is skipped, the real hunk still parses (F70/F71 territory)', () => {
    const dir = repo();
    // Enough shared lines that git's similarity heuristic (-M, default
    // 50% threshold) still recognises this as a rename rather than
    // falling back to delete+add once one line changes.
    const original = [
      'def a():',
      '    pass',
      '',
      'def b():',
      '    pass',
      '',
      'def c():',
      '    pass',
    ];
    write(dir, 'utils.py', original.join('\n') + '\n');
    git(dir, ['add', 'utils.py']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    git(dir, ['mv', 'utils.py', 'helpers.py']);
    const modified = [...original];
    modified[1] = '    return 1';
    write(dir, 'helpers.py', modified.join('\n') + '\n');
    // `git mv` only stages the rename itself; the content edit above is a
    // working-tree change on top of it until it is `add`ed too — without
    // this, `--cached` would show a pure 100%-similarity rename (0 hunks)
    // and the content change would only show up in the unstaged diff.
    git(dir, ['add', 'helpers.py']);

    const raw = diff(dir, ['--cached', '-M']);
    expect(raw).toContain('rename from utils.py');
    expect(raw).toContain('rename to helpers.py');

    const hunks = parseUnifiedDiff(raw);

    expect(hunks.length).toBe(1);
    expect(hunks[0].lines.some((l) => l.type === 'del' && l.text === '    pass')).toBe(
      true,
    );
    expect(
      hunks[0].lines.some((l) => l.type === 'add' && l.text === '    return 1'),
    ).toBe(true);
  });

  it('parses a hunk containing "\\ No newline at end of file" (mid-hunk, old AND new side) without misclassifying it', () => {
    const dir = repo();
    write(dir, 'nonewline.txt', 'a\nb\nc');
    git(dir, ['add', 'nonewline.txt']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    write(dir, 'nonewline.txt', 'a\nb\nc\nd');

    const raw = diff(dir);
    expect(raw).toContain('\\ No newline at end of file');

    const hunks = parseUnifiedDiff(raw);
    expect(hunks.length).toBe(1);

    // Every line is a real content line — no line's text is (or contains
    // as a whole-line artifact) the "\ No newline..." marker itself.
    for (const line of hunks[0].lines) {
      expect(line.text).not.toContain('No newline at end of file');
      expect(['context', 'add', 'del']).toContain(line.type);
    }
    expect(hunks[0].lines.some((l) => l.type === 'del' && l.text === 'c')).toBe(true);
    expect(hunks[0].lines.some((l) => l.type === 'add' && l.text === 'c')).toBe(true);
    expect(hunks[0].lines.some((l) => l.type === 'add' && l.text === 'd')).toBe(true);
  });

  it('parses a file with content lines that themselves start with "+" or "-" using the fixed marker position, not a content scan', () => {
    const dir = repo();
    write(
      dir,
      'markdown.md',
      ['- bullet one', '+build: green', 'unchanged', ''].join('\n'),
    );
    git(dir, ['add', 'markdown.md']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    write(
      dir,
      'markdown.md',
      ['- bullet one', '+build: green', 'unchanged', '- bullet two', ''].join('\n'),
    );

    const hunks = parseUnifiedDiff(diff(dir));

    expect(hunks.length).toBe(1);
    // Context lines whose actual content starts with '+'/'-' must keep
    // that character as part of their text, not have it stripped by a
    // second pass — only the fixed marker column (index 0) is special.
    expect(
      hunks[0].lines.some((l) => l.type === 'context' && l.text === '- bullet one'),
    ).toBe(true);
    expect(
      hunks[0].lines.some((l) => l.type === 'context' && l.text === '+build: green'),
    ).toBe(true);
    // The genuinely added line.
    expect(
      hunks[0].lines.some((l) => l.type === 'add' && l.text === '- bullet two'),
    ).toBe(true);
  });

  it('returns [] for empty diff text (no changes)', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
