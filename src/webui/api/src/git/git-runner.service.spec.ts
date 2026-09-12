// Node's builtin `child_process` exports are non-configurable, so
// `jest.spyOn` cannot patch the real module in place. `jest.mock` swaps the
// whole module out of the registry instead — `execFile` stays wired to the
// real implementation (so every other test in this file still spawns real
// git), but becomes a `jest.fn` we can assert calls against. This must run
// before the imports below so the mock is installed before anything
// (including git-runner.service.ts itself) requires 'child_process'.
jest.mock('child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: jest.fn(actual.execFile) };
});

import {
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as childProcess from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import {
  createTempRepo,
  removeTempRepo,
  writeAndCommit,
} from './__fixtures__/git-repo-fixture';
import {
  GitCommandError,
  GitRunner,
  toHttpException,
} from './git-runner.service';

describe('GitRunner', () => {
  let repo: string;
  let runner: GitRunner;

  beforeEach(() => {
    repo = createTempRepo();
    runner = new GitRunner();
  });

  afterEach(() => {
    removeTempRepo(repo);
  });

  describe('run', () => {
    it('is argv-only — a commit message containing shell metacharacters survives verbatim and executes nothing', async () => {
      writeAndCommit(repo, 'a.txt', 'hello', 'initial');
      const evilMessage = '; rm -rf / && $(touch /tmp/pwned)';

      await runner.run(repo, ['commit', '--allow-empty', '-m', evilMessage]);

      const { stdout } = await runner.run(repo, ['log', '-1', '--format=%B']);
      expect(stdout.trim()).toBe(evilMessage);
      // The whole point of shell:false + argv: nothing was interpreted.
      expect(existsSync('/tmp/pwned')).toBe(false);
    });

    it('rejects with timedOut: true instead of hanging when the timeout fires', async () => {
      // Real timing (a 1ms-or-similar timeout against a genuinely fast
      // command) is inherently flaky — a trivial `git log` can complete
      // before the timer even fires. Instead, put a fake `git` (a shell
      // script that sleeps far longer than the timeout) first on PATH, so
      // the *real* execFile timeout/kill machinery genuinely fires against
      // a genuinely slow process, deterministically.
      const fakeBinDir = mkdtempSync(join(tmpdir(), 'git-fake-bin-'));
      const fakeGit = join(fakeBinDir, 'git');
      writeFileSync(fakeGit, '#!/bin/sh\nsleep 5\n');
      chmodSync(fakeGit, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${delimiter}${originalPath}`;
      try {
        await expect(
          runner.run(repo, ['log'], { timeoutMs: 50 }),
        ).rejects.toMatchObject({ timedOut: true });
      } finally {
        process.env.PATH = originalPath;
        rmSync(fakeBinDir, { recursive: true, force: true });
      }
    });

    it('serializes two concurrent run() calls against the same repo (per-repo mutex)', async () => {
      writeAndCommit(repo, 'a.txt', 'hello', 'initial');
      writeFileSync(join(repo, 'b.txt'), 'b');
      writeFileSync(join(repo, 'c.txt'), 'c');

      // Two `git add` of different files racing on index.lock would fail if
      // GitRunner did not serialize every run() through a per-cwd mutex.
      const [resultA, resultB] = await Promise.all([
        runner.run(repo, ['add', '--', 'b.txt']),
        runner.run(repo, ['add', '--', 'c.txt']),
      ]);
      expect(resultA.exitCode).toBe(0);
      expect(resultB.exitCode).toBe(0);

      const status = await runner.run(repo, ['status', '--porcelain']);
      expect(status.stdout).toContain('b.txt');
      expect(status.stdout).toContain('c.txt');
    });

    it('rejects banned arguments (-C) without running anything', async () => {
      await expect(runner.run(repo, ['-C', '/etc', 'status'])).rejects.toThrow(
        /banned/,
      );
    });

    it('rejects --git-dir and --work-tree, including the = form', async () => {
      await expect(
        runner.run(repo, ['--git-dir', '/etc', 'status']),
      ).rejects.toThrow(/banned/);
      await expect(
        runner.run(repo, ['--work-tree=/etc', 'status']),
      ).rejects.toThrow(/banned/);
    });

    it('resolves instead of throwing when allowFailure is set on a failing command', async () => {
      const result = await runner.run(repo, ['show', 'nonexistent-ref'], {
        allowFailure: true,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it('throws GitCommandError (not resolving) on failure without allowFailure', async () => {
      await expect(
        runner.run(repo, ['show', 'nonexistent-ref']),
      ).rejects.toBeInstanceOf(GitCommandError);
    });
  });

  describe('runWithPathspecs', () => {
    it('rejects a leading-dash pathspec with INVALID_PATHSPEC before spawning anything', async () => {
      const execFileMock = childProcess.execFile as unknown as jest.Mock;
      execFileMock.mockClear();
      await expect(
        runner.runWithPathspecs(repo, ['add'], ['--evil']),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_PATHSPEC' },
      });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('adds the mandatory -- separator and stages the given pathspecs', async () => {
      writeFileSync(join(repo, 'x.txt'), 'x');

      await runner.runWithPathspecs(repo, ['add'], ['x.txt']);
      const status = await runner.run(repo, ['status', '--porcelain']);
      expect(status.stdout).toContain('x.txt');
    });
  });

  describe('checkRefFormat', () => {
    it('accepts a well-formed branch name', async () => {
      await expect(runner.checkRefFormat('feature/x')).resolves.toBe(true);
    });

    it('rejects a name starting with a dot-dot', async () => {
      await expect(runner.checkRefFormat('..bad')).resolves.toBe(false);
    });

    it('rejects a name starting with a leading dash', async () => {
      await expect(runner.checkRefFormat('-leading-dash')).resolves.toBe(false);
    });
  });

  describe('assertNotOptionLike', () => {
    it('throws BadRequestException/INVALID_PATHSPEC for a value starting with -', () => {
      expect(() => runner.assertNotOptionLike('-x', 'revision')).toThrow(
        BadRequestException,
      );
    });

    it('does not throw for an ordinary value', () => {
      expect(() =>
        runner.assertNotOptionLike('feature/x', 'revision'),
      ).not.toThrow();
    });
  });
});

describe('toHttpException', () => {
  it('maps a timed-out GitCommandError to 504 GIT_TIMEOUT', () => {
    const err = new GitCommandError({
      exitCode: -1,
      stdout: '',
      stderr: '',
      args: ['fetch'],
      timedOut: true,
    });
    const mapped = toHttpException(err);
    expect(mapped).toBeInstanceOf(GatewayTimeoutException);
    expect(mapped.getStatus()).toBe(504);
    expect(mapped.getResponse()).toMatchObject({ code: 'GIT_TIMEOUT' });
  });

  it('maps a normal command failure to 422 GIT_COMMAND_FAILED with truncated stderr', () => {
    const longStderr = 'x'.repeat(5000);
    const err = new GitCommandError({
      exitCode: 1,
      stdout: '',
      stderr: longStderr,
      args: ['show', 'bad-ref'],
      timedOut: false,
    });
    const mapped = toHttpException(err);
    expect(mapped).toBeInstanceOf(UnprocessableEntityException);
    expect(mapped.getStatus()).toBe(422);
    const body = mapped.getResponse() as {
      code: string;
      detail: { exitCode: number; args: string[]; stderr: string };
    };
    expect(body.code).toBe('GIT_COMMAND_FAILED');
    expect(body.detail.exitCode).toBe(1);
    expect(body.detail.args).toEqual(['show', 'bad-ref']);
    expect(body.detail.stderr.length).toBe(4000);
  });

  it('passes an existing HttpException through untouched', () => {
    const original = new BadRequestException({
      code: 'INVALID_PATHSPEC',
      message: 'nope',
    });
    expect(toHttpException(original)).toBe(original);
  });

  it('maps an unrelated error to a 500 HttpException rather than throwing', () => {
    const mapped = toHttpException(new Error('boom'));
    expect(mapped).toBeInstanceOf(HttpException);
    expect(mapped.getStatus()).toBe(500);
  });
});
