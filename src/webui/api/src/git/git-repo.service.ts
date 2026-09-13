import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Dirent } from 'fs';
import { realpathSync } from 'fs';
import * as fsp from 'fs/promises';
import { basename, join, resolve as resolvePath } from 'path';
import { ERROR_CODES } from '../common/error-codes';
import { WebuiConfigService } from '../config/webui-config.service';
import { WorkspacePathService } from '../workspace/workspace-path.service';
import { GitRunner } from './git-runner.service';
import { parseGitStatusHeader } from './git-status-parser';

export interface RepoSummary {
  /**
   * Repo-relative to `WEBUI_WORKSPACE_ROOT` — this is exactly the value
   * callers pass back as the `repo` query/body param on every other Git
   * endpoint (F44). Do not reformat or re-derive it elsewhere.
   */
  path: string;
  name: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  isWorktree: boolean;
}

// Directory names skipped during discovery *by name, before* the `.git`
// test ever runs — so `node_modules/pkg/.git` is skipped because
// `node_modules` itself is skipped, never because `pkg` failed a `.git`
// check. Dotdirs (anything starting with `.`, including `.git` itself) are
// skipped by the `startsWith('.')` check below rather than a second set.
const SKIP_EXACT_NAMES = new Set(['node_modules']);

// "depth 2" = direct children of the workspace root, and their direct
// children. depth 0 is the root itself, so candidates are collected at
// depth 1 and depth 2; recursion stops there.
const MAX_SCAN_DEPTH = 2;

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  result: RepoSummary[];
  computedAt: number;
  rootMtimeMs: number;
}

/**
 * Discovers git repos (and worktrees) under `WEBUI_WORKSPACE_ROOT`, and is
 * the single chokepoint (`resolveRepoRoot`) every Git endpoint from here on
 * uses to turn a caller-supplied `repo` into a validated, realpath'd repo
 * root (F44) — controllers never call `WorkspacePathService` directly for
 * `repo`.
 */
@Injectable()
export class GitRepoService {
  private readonly logger = new Logger(GitRepoService.name);
  private readonly workspaceRoot: string;
  private cache: CacheEntry | null = null;

  constructor(
    webuiConfig: WebuiConfigService,
    private readonly workspacePathService: WorkspacePathService,
    private readonly gitRunner: GitRunner,
  ) {
    // Realpath'd once, same rationale as WorkspacePathService: the root
    // itself may sit behind a symlink, and every comparison below assumes
    // both sides have already been realpath'd.
    this.workspaceRoot = realpathSync(webuiConfig.config.workspaceRoot);
  }

  /**
   * Resolves `repo` (a path relative to the workspace root, identical to
   * the `path` field `listRepos()` returns) to an absolute, realpath'd
   * repo root. Throws `REPO_NOT_FOUND` (404) when `repo` doesn't resolve to
   * an existing directory containing `.git`, and lets
   * `PATH_OUTSIDE_WORKSPACE`/`VALIDATION_ERROR` from `WorkspacePathService`
   * propagate unchanged for anything else.
   */
  async resolveRepoRoot(repo: string): Promise<string> {
    let abs: string;
    try {
      abs = this.workspacePathService.resolve(repo, { mustExist: true });
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw this.repoNotFound(repo);
      }
      throw err;
    }

    const stat = await fsp.stat(abs);
    if (!stat.isDirectory()) {
      throw this.repoNotFound(repo);
    }

    try {
      // File or directory both count — the worktree case is a file.
      await fsp.lstat(join(abs, '.git'));
    } catch {
      throw this.repoNotFound(repo);
    }

    return abs;
  }

  /**
   * Lists every discovered repo, using a 30s cache keyed on the workspace
   * root's own mtime (so a newly created top-level repo is picked up
   * immediately — creating it bumps the root's mtime — while everything
   * else refreshes at most every 30s). `refresh: true` (`?refresh=1`)
   * forces a full rescan regardless.
   */
  async listRepos(opts: { refresh?: boolean } = {}): Promise<RepoSummary[]> {
    const rootStat = await fsp.stat(this.workspaceRoot);
    if (
      !opts.refresh &&
      this.cache !== null &&
      this.cache.rootMtimeMs === rootStat.mtimeMs &&
      Date.now() - this.cache.computedAt < CACHE_TTL_MS
    ) {
      return this.cache.result;
    }

    const result = await this.discoverRepos();
    this.cache = {
      result,
      computedAt: Date.now(),
      rootMtimeMs: rootStat.mtimeMs,
    };
    return result;
  }

  private async discoverRepos(): Promise<RepoSummary[]> {
    const candidates: string[] = [];
    await this.collectCandidates(this.workspaceRoot, 0, candidates);

    const summaries: RepoSummary[] = [];
    for (const candidateDir of candidates) {
      const summary = await this.classify(candidateDir);
      if (summary !== null) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  /** Recursively collects candidate repo directories up to `MAX_SCAN_DEPTH`. */
  private async collectCandidates(
    dir: string,
    depth: number,
    out: string[],
  ): Promise<void> {
    if (depth >= MAX_SCAN_DEPTH) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.logger.warn(
        `Repo discovery: failed to read directory ${dir}: ${String(err)}`,
      );
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const name = entry.name;
      // Name check BEFORE the `.git` test — a skipped directory is never
      // recursed into either, which is what makes
      // `node_modules/pkg/.git` skipped by name rather than by luck.
      if (SKIP_EXACT_NAMES.has(name) || name.startsWith('.')) {
        continue;
      }

      const childPath = join(dir, name);
      if (await this.hasDotGit(childPath)) {
        out.push(childPath);
      }
      await this.collectCandidates(childPath, depth + 1, out);
    }
  }

  private async hasDotGit(dir: string): Promise<boolean> {
    try {
      // File or directory both count (the worktree case is a file).
      await fsp.lstat(join(dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Classifies one candidate with a single `git rev-parse` call and, on
   * success, a header-only `git status` call. Any failure (most commonly a
   * stale/broken worktree pointer) is logged and the candidate is skipped
   * rather than thrown — one broken repo must not 500 the whole list.
   */
  private async classify(candidateDir: string): Promise<RepoSummary | null> {
    try {
      // Goes through GitRunner like every other git call. `--git-dir` here
      // is rev-parse's query flag, not a top-level redirect, so the runner's
      // banned-arg guard (scoped to the leading option run) permits it.
      const { stdout } = await this.gitRunner.run(
        candidateDir,
        [
          'rev-parse',
          '--show-toplevel',
          '--git-dir',
          '--git-common-dir',
          '--absolute-git-dir',
        ],
        { timeoutMs: 5_000 },
      );
      const lines = stdout.split('\n');
      const toplevelLine = lines[0]?.trim() ?? '';
      const gitDirLine = lines[1]?.trim() ?? '';
      const gitCommonDirLine = lines[2]?.trim() ?? '';

      // git may print `--git-dir`/`--git-common-dir` as relative or
      // absolute depending on flag interaction, so resolve against the
      // cwd we ran in and realpath both before comparing — a raw string
      // compare here can misclassify (F49).
      const realToplevel = realpathSync(
        resolvePath(candidateDir, toplevelLine),
      );
      const realGitDir = realpathSync(resolvePath(candidateDir, gitDirLine));
      const realGitCommonDir = realpathSync(
        resolvePath(candidateDir, gitCommonDirLine),
      );

      const { stdout: statusOut } = await this.gitRunner.run(realToplevel, [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
      ]);
      const header = parseGitStatusHeader(statusOut);

      return {
        path: this.workspacePathService.toRelative(realToplevel),
        name: basename(realToplevel),
        branch: header.branch,
        upstream: header.upstream,
        ahead: header.ahead,
        behind: header.behind,
        dirty: header.dirty,
        isWorktree: realGitDir !== realGitCommonDir,
      };
    } catch (err) {
      this.logger.warn(
        `Repo discovery: skipping unclassifiable candidate ${candidateDir}: ${String(err)}`,
      );
      return null;
    }
  }

  private repoNotFound(repo: string): NotFoundException {
    return new NotFoundException({
      code: ERROR_CODES.REPO_NOT_FOUND,
      message: `Repo not found: ${repo}`,
    });
  }
}
