import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
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

function requireRepoParam(rawRepo: unknown): string {
  if (typeof rawRepo !== 'string' || rawRepo.length === 0) {
    throw new BadRequestException({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'repo query parameter is required',
    });
  }
  return rawRepo;
}

function requireRevParam(rawRev: unknown): string {
  if (typeof rawRev !== 'string' || rawRev.length === 0) {
    throw new BadRequestException({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'rev query parameter is required',
    });
  }
  return rawRev;
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
}
