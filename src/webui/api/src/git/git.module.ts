import { Module } from '@nestjs/common';
import { GitRunner } from './git-runner.service';

// No controller yet — the git HTTP surface arrives in T8+. This module
// exists so GitRunner can be depended on by name from other modules ahead
// of that.
@Module({
  providers: [GitRunner],
  exports: [GitRunner],
})
export class GitModule {}
