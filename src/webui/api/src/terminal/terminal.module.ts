import { Module } from '@nestjs/common';
import { TmuxService } from './tmux.service';

// No controller yet — GET/POST /api/terminals and the WebSocket upgrade
// handler arrive in T17/T18. This module exists now so TmuxService is
// wired into the app (and importable by T17) as soon as it lands.
@Module({
  providers: [TmuxService],
  exports: [TmuxService],
})
export class TerminalModule {}
