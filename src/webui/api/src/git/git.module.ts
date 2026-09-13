import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { GitController } from './git.controller';
import { GitBranchService } from './git-branch.service';
import { GitChangesService } from './git-changes.service';
import { GitDiffService } from './git-diff.service';
import { GitLogService } from './git-log.service';
import { GitRemoteService } from './git-remote.service';
import { GitRepoService } from './git-repo.service';
import { GitRunner } from './git-runner.service';
import { GitStashService } from './git-stash.service';
import { GitStatusService } from './git-status.service';

// GitRepoService depends on WorkspacePathService (repo-root containment and
// `path` <-> relative-path conversion), hence the WorkspaceModule import.
@Module({
  imports: [WorkspaceModule],
  controllers: [GitController],
  providers: [
    GitRunner,
    GitRepoService,
    GitStatusService,
    GitDiffService,
    GitLogService,
    GitChangesService,
    GitBranchService,
    GitRemoteService,
    GitStashService,
  ],
  exports: [
    GitRunner,
    GitRepoService,
    GitStatusService,
    GitDiffService,
    GitLogService,
    GitChangesService,
    GitBranchService,
    GitRemoteService,
    GitStashService,
  ],
})
export class GitModule {}
