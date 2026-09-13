import { Controller, Get, Query } from '@nestjs/common';
import { GitRepoService, RepoSummary } from './git-repo.service';
import { parseBoolFlag } from './git-query.util';

@Controller('api')
export class GitController {
  constructor(private readonly gitRepoService: GitRepoService) {}

  @Get('repos')
  listRepos(@Query('refresh') refresh?: string): Promise<RepoSummary[]> {
    return this.gitRepoService.listRepos({ refresh: parseBoolFlag(refresh) });
  }
}
