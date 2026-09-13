import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { TerminalController } from './terminal.controller';
import { TerminalTicketService } from './terminal-ticket.service';
import { TmuxService } from './tmux.service';

// TerminalController resolves a terminal's `cwd` through
// WorkspacePathService, NOT GitRepoService.resolveRepoRoot — a terminal's
// cwd need not be a git repo (opening a terminal on a plain directory from
// the file browser is valid, and resolveRepoRoot would wrongly 404 it by
// demanding `.git`). Hence WorkspaceModule, not GitModule, is imported here
// (F39).
@Module({
  imports: [WorkspaceModule],
  controllers: [TerminalController],
  providers: [TmuxService, TerminalTicketService],
  exports: [TmuxService, TerminalTicketService],
})
export class TerminalModule {}
