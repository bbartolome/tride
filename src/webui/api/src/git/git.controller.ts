import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
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
import { GitRepoService, RepoSummary } from './git-repo.service';
import { toHttpException } from './git-runner.service';
import { parseBoolFlag, parseIntParam } from './git-query.util';
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
}
