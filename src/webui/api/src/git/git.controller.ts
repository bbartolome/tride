import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
import { GitRepoService, RepoSummary } from './git-repo.service';
import { toHttpException } from './git-runner.service';
import { parseBoolFlag } from './git-query.util';
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

@Controller('api')
export class GitController {
  constructor(
    private readonly gitRepoService: GitRepoService,
    private readonly gitStatusService: GitStatusService,
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
}
