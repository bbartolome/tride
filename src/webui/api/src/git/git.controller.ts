import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
import {
  BranchListResult,
  CheckoutOptions,
  CreateBranchOptions,
  DeleteBranchOptions,
  GitBranchService,
} from './git-branch.service';
import {
  CommitOptions,
  CommitResult,
  GitChangesService,
  StageOptions,
} from './git-changes.service';
import {
  DiffResponse,
  DiffSummaryEntry,
  GitDiffService,
} from './git-diff.service';
import { GitLogEntry, GitLogService, GitShowResult } from './git-log.service';
import {
  FetchOptions,
  GitRemoteService,
  PullOptions,
  PushOptions,
  RemoteInfo,
} from './git-remote.service';
import { GitRepoService, RepoSummary } from './git-repo.service';
import { toHttpException } from './git-runner.service';
import { parseBoolFlag, parseIntParam } from './git-query.util';
import { resolveSshAuthSock } from './ssh-auth-sock.util';
import { GitStatusResult, GitStatusService } from './git-status.service';

function validationError(message: string): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_ERROR,
    message,
  });
}

function requireRepoParam(rawRepo: unknown): string {
  if (typeof rawRepo !== 'string' || rawRepo.length === 0) {
    throw validationError('repo query parameter is required');
  }
  return rawRepo;
}

function requireRevParam(rawRev: unknown): string {
  if (typeof rawRev !== 'string' || rawRev.length === 0) {
    throw validationError('rev query parameter is required');
  }
  return rawRev;
}

function asBodyRecord(body: unknown): Record<string, unknown> {
  return (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
}

/**
 * Shared by /git/stage and /git/unstage: the body must carry EXACTLY one of
 * `paths` (a non-empty string array) or `all:true` — both together, or
 * neither, is a 400 VALIDATION_ERROR (rather than silently preferring one).
 */
function parsePathsOrAll(record: Record<string, unknown>): StageOptions {
  const pathsProvided = record.paths !== undefined;
  const allProvided = record.all === true;

  if (pathsProvided && allProvided) {
    throw validationError(
      'specify exactly one of "paths" or "all:true", not both',
    );
  }
  if (!pathsProvided && !allProvided) {
    throw validationError('specify exactly one of "paths" or "all:true"');
  }
  if (allProvided) {
    return { all: true };
  }

  const rawPaths = record.paths;
  if (
    !Array.isArray(rawPaths) ||
    rawPaths.length === 0 ||
    !rawPaths.every((p) => typeof p === 'string')
  ) {
    throw validationError('paths must be a non-empty array of strings');
  }
  return { paths: rawPaths };
}

interface DiscardBody {
  paths: string[];
}

// The single literal `confirm` must equal for /git/discard to proceed —
// checked, and rejected, BEFORE any git call whatsoever (including before
// `paths` is even validated), since this is the most destructive endpoint
// in the app.
const DISCARD_CONFIRM_LITERAL = 'discard';

function parseDiscardBody(record: Record<string, unknown>): DiscardBody {
  if (record.confirm !== DISCARD_CONFIRM_LITERAL) {
    throw new BadRequestException({
      code: ERROR_CODES.CONFIRMATION_REQUIRED,
      message: `confirm must equal "${DISCARD_CONFIRM_LITERAL}"`,
    });
  }
  const rawPaths = record.paths;
  if (
    !Array.isArray(rawPaths) ||
    rawPaths.length === 0 ||
    !rawPaths.every((p) => typeof p === 'string')
  ) {
    throw validationError('paths must be a non-empty array of strings');
  }
  return { paths: rawPaths };
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${label} is required and must be a string`);
  }
  return value;
}

function parseOptionalStartPoint(
  record: Record<string, unknown>,
): string | undefined {
  const { startPoint } = record;
  if (startPoint === undefined) {
    return undefined;
  }
  return requireNonEmptyString(startPoint, 'startPoint');
}

function parseCheckoutBody(record: Record<string, unknown>): CheckoutOptions {
  return {
    branch: requireNonEmptyString(record.branch, 'branch'),
    create: record.create === true,
    startPoint: parseOptionalStartPoint(record),
  };
}

function parseCreateBranchBody(
  record: Record<string, unknown>,
): CreateBranchOptions {
  return {
    name: requireNonEmptyString(record.name, 'name'),
    startPoint: parseOptionalStartPoint(record),
  };
}

function parseDeleteBranchBody(
  record: Record<string, unknown>,
): DeleteBranchOptions {
  return {
    name: requireNonEmptyString(record.name, 'name'),
    force: record.force === true,
  };
}

function parseCommitBody(record: Record<string, unknown>): CommitOptions {
  const message = record.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw validationError(
      'message is required and must contain at least one non-whitespace character',
    );
  }
  return {
    message,
    amend: record.amend === true,
    signoff: record.signoff === true,
  };
}

function parseOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, key);
}

function parseFetchBody(record: Record<string, unknown>): FetchOptions {
  return {
    remote: parseOptionalString(record, 'remote'),
    prune: record.prune === true,
  };
}

function parsePullBody(record: Record<string, unknown>): PullOptions {
  return {
    remote: parseOptionalString(record, 'remote'),
    branch: parseOptionalString(record, 'branch'),
  };
}

// The single literal `confirm` must equal for a forced /git/push to
// proceed — checked, and rejected, BEFORE any git call whatsoever, same
// destructive-confirmation shape as /git/discard's `DISCARD_CONFIRM_LITERAL`
// above. Reuses CONFIRMATION_REQUIRED (F89) rather than adding a new code.
const FORCE_PUSH_CONFIRM_LITERAL = 'force push';

function parsePushBody(record: Record<string, unknown>): PushOptions {
  const force = record.force === true;
  if (force && record.confirm !== FORCE_PUSH_CONFIRM_LITERAL) {
    throw new BadRequestException({
      code: ERROR_CODES.CONFIRMATION_REQUIRED,
      message: `confirm must equal "${FORCE_PUSH_CONFIRM_LITERAL}"`,
    });
  }
  return {
    remote: parseOptionalString(record, 'remote'),
    branch: parseOptionalString(record, 'branch'),
    setUpstream: record.setUpstream === true,
    force,
  };
}

const DEFAULT_DIFF_CONTEXT = 3;
const MAX_DIFF_CONTEXT = 100;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
const MAX_LOG_SKIP = 100_000;

@Controller('api')
export class GitController {
  constructor(
    private readonly gitRepoService: GitRepoService,
    private readonly gitStatusService: GitStatusService,
    private readonly gitDiffService: GitDiffService,
    private readonly gitLogService: GitLogService,
    private readonly gitChangesService: GitChangesService,
    private readonly gitBranchService: GitBranchService,
    private readonly gitRemoteService: GitRemoteService,
  ) {}

  @Get('repos')
  listRepos(@Query('refresh') refresh?: string): Promise<RepoSummary[]> {
    return this.gitRepoService.listRepos({ refresh: parseBoolFlag(refresh) });
  }

  @Get('git/status')
  async status(@Query('repo') repo?: string): Promise<GitStatusResult> {
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(repo),
    );
    try {
      return await this.gitStatusService.getStatus(repoRoot);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('git/diff')
  async diff(
    @Query('repo') repo?: string,
    @Query('path') path?: string,
    @Query('staged') staged?: string,
    @Query('context') context?: string,
  ): Promise<DiffResponse> {
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(repo),
    );
    try {
      return await this.gitDiffService.diff(repoRoot, {
        path,
        staged: parseBoolFlag(staged),
        // min 0, not the default 1: `git diff -U0` is valid and produces a
        // genuinely different (tighter) diff, so ?context=0 must not be
        // floored up to 1. Same class of bug as ?skip=0 below.
        context: parseIntParam(
          context,
          DEFAULT_DIFF_CONTEXT,
          MAX_DIFF_CONTEXT,
          0,
        ),
      });
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('git/diff/summary')
  async diffSummary(
    @Query('repo') repo?: string,
    @Query('staged') staged?: string,
  ): Promise<DiffSummaryEntry[]> {
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(repo),
    );
    try {
      return await this.gitDiffService.diffSummary(repoRoot, {
        staged: parseBoolFlag(staged),
      });
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('git/show')
  async show(
    @Query('repo') repo?: string,
    @Query('rev') rev?: string,
    @Query('path') path?: string,
  ): Promise<GitShowResult> {
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(repo),
    );
    const revValue = requireRevParam(rev);
    try {
      return await this.gitLogService.show(repoRoot, revValue, path);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('git/log')
  async log(
    @Query('repo') repo?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('path') path?: string,
  ): Promise<GitLogEntry[]> {
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(repo),
    );
    try {
      return await this.gitLogService.log(repoRoot, {
        limit: parseIntParam(limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT),
        // min:0 — an explicit `?skip=0` must mean "no offset", not get
        // floored up to 1 by parseIntParam's normal >=1 minimum.
        skip: parseIntParam(skip, 0, MAX_LOG_SKIP, 0),
        path,
      });
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/stage')
  @HttpCode(200)
  async stage(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parsePathsOrAll(record);
    try {
      await this.gitChangesService.stage(repoRoot, opts);
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/unstage')
  @HttpCode(200)
  async unstage(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parsePathsOrAll(record);
    try {
      await this.gitChangesService.unstage(repoRoot, opts);
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/discard')
  @HttpCode(200)
  async discard(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    // Checked before the git call this guards, per this endpoint's
    // destructive-confirmation contract — see `parseDiscardBody`.
    const { paths } = parseDiscardBody(record);
    try {
      await this.gitChangesService.discard(repoRoot, paths);
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/commit')
  @HttpCode(200)
  async commit(@Body() body: unknown): Promise<CommitResult> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parseCommitBody(record);
    try {
      return await this.gitChangesService.commit(repoRoot, opts);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('git/branches')
  async branches(@Query('repo') repo?: string): Promise<BranchListResult> {
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(repo),
    );
    try {
      return await this.gitBranchService.listBranches(repoRoot);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/checkout')
  @HttpCode(200)
  async checkout(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parseCheckoutBody(record);
    try {
      await this.gitBranchService.checkout(repoRoot, opts);
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/branch')
  @HttpCode(200)
  async createBranch(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parseCreateBranchBody(record);
    try {
      await this.gitBranchService.createBranch(repoRoot, opts);
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Delete('git/branch')
  @HttpCode(200)
  async deleteBranch(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parseDeleteBranchBody(record);
    try {
      await this.gitBranchService.deleteBranch(repoRoot, opts);
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('git/remotes')
  async remotes(@Query('repo') repo?: string): Promise<RemoteInfo[]> {
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(repo),
    );
    try {
      return await this.gitRemoteService.listRemotes(repoRoot);
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/fetch')
  @HttpCode(200)
  async fetch(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parseFetchBody(record);
    try {
      // Resolved fresh on every request, never cached at boot (see
      // `resolveSshAuthSock`'s doc comment) — the agent may be started
      // later by an SSH login, and this is what makes push/pull/fetch start
      // working again without restarting this server.
      await this.gitRemoteService.fetch(repoRoot, opts, resolveSshAuthSock());
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/pull')
  @HttpCode(200)
  async pull(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    const opts = parsePullBody(record);
    try {
      await this.gitRemoteService.pull(repoRoot, opts, resolveSshAuthSock());
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('git/push')
  @HttpCode(200)
  async push(@Body() body: unknown): Promise<{ ok: true }> {
    const record = asBodyRecord(body);
    const repoRoot = await this.gitRepoService.resolveRepoRoot(
      requireRepoParam(record.repo),
    );
    // Checked before the git call this guards, per the destructive-
    // confirmation contract shared with /git/discard — see `parsePushBody`.
    const opts = parsePushBody(record);
    try {
      await this.gitRemoteService.push(repoRoot, opts, resolveSshAuthSock());
      return { ok: true };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}
