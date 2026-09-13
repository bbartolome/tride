import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { GitController } from './git.controller';
import { GitRepoService } from './git-repo.service';
import { GitRunner } from './git-runner.service';
import { GitStatusService } from './git-status.service';

// GitRepoService depends on WorkspacePathService (repo-root containment and
// `path` <-> relative-path conversion), hence the WorkspaceModule import.
@Module({
  imports: [WorkspaceModule],
  controllers: [GitController],
  providers: [GitRunner, GitRepoService, GitStatusService],
  exports: [GitRunner, GitRepoService, GitStatusService],
})
export class GitModule {}
