import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspacePathService } from './workspace-path.service';

@Module({
  controllers: [WorkspaceController],
  providers: [WorkspacePathService],
  exports: [WorkspacePathService],
})
export class WorkspaceModule {}
