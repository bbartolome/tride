import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { PtyService } from './pty.service';
import { TerminalController } from './terminal.controller';
import { TerminalTicketService } from './terminal-ticket.service';
import { TerminalWsGateway } from './terminal.ws';
import { TmuxService } from './tmux.service';

// TerminalController resolves a terminal's `cwd` through
// WorkspacePathService, NOT GitRepoService.resolveRepoRoot — a terminal's
// cwd need not be a git repo (opening a terminal on a plain directory from
// the file browser is valid, and resolveRepoRoot would wrongly 404 it by
// demanding `.git`). Hence WorkspaceModule, not GitModule, is imported here
// (F39).
//
// AuthModule is imported for `UsersService` (exported from there): the
// `/ws/term` upgrade handler in `TerminalWsGateway` re-checks the allowlist
// by hand, since an HTTP upgrade never reaches Nest's guard pipeline (F113).
//
// `TerminalWsGateway` is registered as an ordinary provider, not wired from
// `main.ts` (F114): it self-attaches to the real `http.Server` from its own
// `OnModuleInit`, which Nest calls for every provider in the module graph
// regardless of how the app was bootstrapped (`app.listen()` in `main.ts`
// or `Test.createTestingModule(...).createNestApplication()` + `app.init()`
// in the e2e suite).
@Module({
  imports: [WorkspaceModule, AuthModule],
  controllers: [TerminalController],
  providers: [
    TmuxService,
    TerminalTicketService,
    PtyService,
    TerminalWsGateway,
  ],
  exports: [TmuxService, TerminalTicketService],
})
export class TerminalModule {}
