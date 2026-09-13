import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { statSync } from 'fs';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Identity } from '../auth/identity.middleware';
import { ERROR_CODES } from '../common/error-codes';
import { WorkspacePathService } from '../workspace/workspace-path.service';
import { computeSessionName, type TerminalMode } from './session-name.util';
import type { MintedTicket } from './terminal-ticket.service';
import { TerminalTicketService } from './terminal-ticket.service';
import { TmuxService, type TmuxSessionInfo } from './tmux.service';

export interface TerminalSummary {
  id: string;
  /** Workspace-relative — an absolute host path must never reach the
   * client (same rule as every other endpoint touching WorkspacePathService). */
  cwd: string;
  mode: TerminalMode;
  label: string;
  createdAt: number;
}

// This exact string gets embedded in a shell-parsed command by T19's
// `claude --remote-control <label>` launch — validating it here is what
// makes quoting unnecessary there. See plan.md's "No quoting, by
// construction" note.
// Must start alphanumeric. The label is a POSITIONAL argument to `claude`
// in T19's quick-launch, so a leading dash would be parsed as a flag
// rather than a session name -- `--dangerously-skip-permissions` as a
// label is the sharp version of that. Same rule the git side enforces
// with assertNotOptionLike; validating here is what lets T19 embed the
// value without quoting it.
const CLAUDE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- deliberately matching control chars
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const MAX_SHELL_LABEL_LENGTH = 100;

// A sane upper bound on how many independent plain-shell terminals one
// directory can have open at once before we give up and 500 rather than
// looping forever.
const MAX_SHELL_SLOTS = 64;

function validationError(message: string): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_ERROR,
    message,
  });
}

function asBodyRecord(body: unknown): Record<string, unknown> {
  return (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
}

function requireCwd(record: Record<string, unknown>): string {
  const raw = record.cwd;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw validationError('cwd is required and must be a string');
  }
  return raw;
}

/**
 * Resolves and validates a terminal's `cwd`. This is the strongest
 * privilege boundary in the whole app — a terminal is a shell, so its cwd
 * decides what the shell can touch — and containment is checked exactly
 * once, here, at creation (F39). T18's WS attach only ever receives an
 * already-validated session *name*, never a raw path, so there is no second
 * trust boundary to get right.
 *
 * Deliberately `WorkspacePathService.resolve`, NOT
 * `GitRepoService.resolveRepoRoot`: a terminal's cwd need not be a git repo
 * (opening a terminal on a plain directory from the file browser is valid),
 * and `resolveRepoRoot` would wrongly 404 it by demanding `.git`.
 */
function resolveTerminalCwd(
  workspacePathService: WorkspacePathService,
  rawCwd: string,
): string {
  let abs: string;
  try {
    abs = workspacePathService.resolve(rawCwd, { mustExist: true });
  } catch (err) {
    if (err instanceof NotFoundException) {
      // `resolve`'s mustExist throws a generic, code-less NotFoundException.
      // Letting that 404 through unchanged would read identically to
      // TERMINAL_NOT_FOUND to a client — a missing cwd is a client input
      // mistake, not "the terminal doesn't exist", so it becomes 400
      // VALIDATION_ERROR instead. PATH_OUTSIDE_WORKSPACE (Forbidden) and the
      // NUL-byte VALIDATION_ERROR (BadRequest) already carry their own codes
      // and propagate unchanged.
      throw validationError(`cwd does not exist: ${rawCwd}`);
    }
    throw err;
  }

  // A file path must 400, not silently become a `-c <file>` tmux
  // invocation — tmux's `-c` wants a directory.
  if (!statSync(abs).isDirectory()) {
    throw validationError('cwd must be a directory, not a file');
  }
  return abs;
}

function parseMode(record: Record<string, unknown>): TerminalMode {
  const raw = record.mode;
  if (raw === undefined) {
    return 'shell';
  }
  if (raw !== 'shell' && raw !== 'claude') {
    throw validationError('mode must be "shell" or "claude"');
  }
  return raw;
}

function parseClaudeLabel(record: Record<string, unknown>): string {
  const raw = record.label;
  if (typeof raw !== 'string' || !CLAUDE_LABEL_RE.test(raw)) {
    throw validationError(
      'label is required for mode "claude" and must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/',
    );
  }
  return raw;
}

/** For `mode:"shell"`: optional, freeform, display-only — never embedded in
 * a shell command, so it only needs trimming/capping/control-char rejection
 * rather than the claude label's strict allowlist. */
function parseShellLabel(record: Record<string, unknown>): string | undefined {
  const raw = record.label;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw validationError('label must be a string');
  }
  const trimmed = raw.trim().slice(0, MAX_SHELL_LABEL_LENGTH);
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw validationError(
      'label must not contain control characters or newlines',
    );
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

@Controller('api')
export class TerminalController {
  constructor(
    private readonly tmuxService: TmuxService,
    private readonly ticketService: TerminalTicketService,
    private readonly workspacePathService: WorkspacePathService,
  ) {}

  @Get('terminals')
  async list(): Promise<TerminalSummary[]> {
    const sessions = await this.tmuxService.list();
    return sessions.map((session) => this.toSummary(session));
  }

  @Post('terminals')
  @HttpCode(200)
  async create(@Body() body: unknown): Promise<TerminalSummary> {
    const record = asBodyRecord(body);
    const absCwd = resolveTerminalCwd(
      this.workspacePathService,
      requireCwd(record),
    );
    const mode = parseMode(record);

    let name: string;
    let label: string;
    if (mode === 'claude') {
      // Validated (and rejected) before any tmux call, and before the
      // session name is even computed for consistency with that rule.
      label = parseClaudeLabel(record);
      // Slot 0 always: this is what makes a second quick-launch in the same
      // directory attach to the existing session instead of starting a
      // second `claude` (F114/F120).
      name = computeSessionName(absCwd, 'claude', 0);
    } else {
      const requestedLabel = parseShellLabel(record);
      const slot = await this.findFreeShellSlot(absCwd);
      name = computeSessionName(absCwd, 'shell', slot);
      label = requestedLabel ?? `Shell ${slot + 1}`;
    }

    const info = await this.tmuxService.create({
      name,
      absCwd,
      mode,
      label,
    });
    return this.toSummary(info);
  }

  @Delete('terminals/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    if (!(await this.existsSafe(id))) {
      throw this.terminalNotFound(id);
    }
    await this.tmuxService.kill(id);
  }

  @Post('terminals/:id/ticket')
  @HttpCode(200)
  async mintTicket(
    @Param('id') id: string,
    @CurrentUser() identity: Identity | null,
  ): Promise<MintedTicket> {
    if (!(await this.existsSafe(id))) {
      throw this.terminalNotFound(id);
    }
    // This route sits behind the global guards (SameOriginGuard +
    // TailscaleAuthGuard), so `identity` is guaranteed non-null here — same
    // invariant UsersController.me() relies on for its non-@Public() routes.
    const login = identity?.login ?? 'unknown';
    return this.ticketService.mint(login, id);
  }

  /**
   * Probes `slot = 0, 1, 2, …` for the first unused shell session name in
   * `absCwd`, so opening two independent plain shells in the same directory
   * doesn't collapse them into one (unlike `mode:"claude"`, which always
   * uses slot 0 on purpose).
   */
  private async findFreeShellSlot(absCwd: string): Promise<number> {
    for (let slot = 0; slot < MAX_SHELL_SLOTS; slot++) {
      const name = computeSessionName(absCwd, 'shell', slot);
      if (!(await this.tmuxService.exists(name))) {
        return slot;
      }
    }
    throw new InternalServerErrorException({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: `No free shell slot in this directory after ${MAX_SHELL_SLOTS} attempts`,
    });
  }

  /**
   * `true`/`false` for a well-formed id; `false` (never a throw) for a
   * malformed one. `TmuxService.exists()` throws a plain `Error` for a name
   * that fails its session-name allowlist — such an id can never correspond
   * to a real terminal, so it is treated the same as "not found" rather
   * than leaking a 500.
   */
  private async existsSafe(id: string): Promise<boolean> {
    try {
      return await this.tmuxService.exists(id);
    } catch {
      return false;
    }
  }

  private terminalNotFound(id: string): NotFoundException {
    return new NotFoundException({
      code: ERROR_CODES.TERMINAL_NOT_FOUND,
      message: `Terminal not found: ${id}`,
    });
  }

  private toSummary(info: TmuxSessionInfo): TerminalSummary {
    return {
      id: info.name,
      cwd: this.workspacePathService.toRelative(info.cwd),
      mode: info.mode,
      label: info.label,
      createdAt: info.createdAt,
    };
  }
}
