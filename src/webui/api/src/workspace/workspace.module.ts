import { Module } from '@nestjs/common';
import { WorkspacePathService } from './workspace-path.service';

// No controller yet — the filesystem/git HTTP surface arrives in T8. This
// module exists so WorkspacePathService can be depended on by name from
// other modules ahead of that.
@Module({
  providers: [WorkspacePathService],
  exports: [WorkspacePathService],
})
export class WorkspaceModule {}
