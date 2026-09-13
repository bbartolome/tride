import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { GitController } from './git.controller';
import { GitRepoService } from './git-repo.service';
import { GitRunner } from './git-runner.service';

// GitRepoService depends on WorkspacePathService (repo-root containment and
// `path` <-> relative-path conversion), hence the WorkspaceModule import.
@Module({
  imports: [WorkspaceModule],
  controllers: [GitController],
  providers: [GitRunner, GitRepoService],
  exports: [GitRunner, GitRepoService],
})
export class GitModule {}
