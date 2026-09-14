import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IPty } from '@lydell/node-pty';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Socket } from 'net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { isSameOriginUpgrade } from '../auth/same-origin.guard';
import { normalizeLogin } from '../auth/identity.middleware';
import { UsersService } from '../auth/users.service';
import { ERROR_CODES } from '../common/error-codes';
import { WorkspacePathService } from '../workspace/workspace-path.service';
import { OutputCoalescer } from './output-coalescer';
import { PtyService } from './pty.service';
import { TerminalTicketService } from './terminal-ticket.service';
import { TmuxService } from './tmux.service';

const WS_PATH = '/ws/term';
const SESSION_ID_RE = /^wui-[0-9a-f]{12}$/;

// Sane bounds on client-supplied terminal geometry: large enough for any
// real terminal, small enough that a hostile/buggy client can't get us to
// allocate something absurd.
const MIN_DIM = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 500;

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
};

type HeaderBag = Record<string, string | string[] | undefined>;

function firstHeaderValue(
  headers: HeaderBag,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? raw[0] : raw;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

interface AttachMessage {
  type: 'attach';
  cols: number;
  rows: number;
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDims(value: unknown): { cols: number; rows: number } | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { cols, rows } = value;
  if (
    typeof cols !== 'number' ||
    typeof rows !== 'number' ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < MIN_DIM ||
    rows < MIN_DIM ||
    cols > MAX_COLS ||
    rows > MAX_ROWS
  ) {
    return null;
  }
  return { cols, rows };
}

function parseAttach(value: unknown): AttachMessage | null {
  if (!isPlainObject(value) || value.type !== 'attach') {
    return null;
  }
  const dims = parseDims(value);
  return dims ? { type: 'attach', ...dims } : null;
}

function parseResize(value: unknown): ResizeMessage | null {
  if (!isPlainObject(value) || value.type !== 'resize') {
    return null;
  }
  const dims = parseDims(value);
  return dims ? { type: 'resize', ...dims } : null;
}

function isPingMessage(value: unknown): boolean {
  return isPlainObject(value) && value.type === 'ping';
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Resolved, pre-connection context for one accepted upgrade. */
interface AttachContext {
  sessionName: string;
  cwd: string;
  mode: string;
}

/**
 * Writes a real `HTTP/1.1 <status> ...` response on the raw upgrade socket
 * and destroys it. Never a bare `destroy()` for anything past the routing
 * check — that is what makes the `ws` client's connection attempt fail
 * with a readable `unexpected-response` (status + JSON body) instead of an
 * opaque ECONNRESET, which is how the e2e tests assert on rejections.
 */
function rejectUpgrade(
  socket: Socket,
  status: number,
  code: string,
  message: string,
): void {
  const body = JSON.stringify({ code, message });
  const statusText = STATUS_TEXT[status] ?? 'Error';
  const head = [
    `HTTP/1.1 ${status} ${statusText}`,
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    '',
  ].join('\r\n');
  try {
    socket.write(head + body);
  } catch {
    // Socket already gone — nothing left to do.
  }
  socket.destroy();
}

/**
 * Attaches a raw `ws.Server({noServer:true})` to Nest's real HTTP server
 * via `server.on('upgrade', …)`, self-wired from `OnModuleInit` rather than
 * from `main.ts` (F114): the same `http.Server` exists immediately after
 * `NestFactory.create()`, before `.listen()`, so this attaches whether the
 * app boots through `main.ts` or through
 * `Test.createTestingModule(...).createNestApplication()` + `app.init()` —
 * which is what lets the e2e suite exercise the real upgrade path at all.
 *
 * `/ws/term` is deliberately NOT protected by the ordinary Nest guards
 * (`SameOriginGuard`/`TailscaleAuthGuard`): an HTTP upgrade never reaches
 * Nest's routing/guard pipeline (Express never sees an `upgrade` event), so
 * every check those guards perform is re-implemented here, by hand, against
 * the raw upgrade request — see `handleUpgrade` below.
 */
@Injectable()
export class TerminalWsGateway implements OnModuleInit {
  private readonly logger = new Logger(TerminalWsGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tmuxService: TmuxService,
    private readonly usersService: UsersService,
    private readonly ticketService: TerminalTicketService,
    private readonly ptyService: PtyService,
    private readonly workspacePathService: WorkspacePathService,
  ) {}

  onModuleInit(): void {
    const httpServer =
      this.adapterHost.httpAdapter.getHttpServer() as HttpServer;
    httpServer.on(
      'upgrade',
      (req: IncomingMessage, socket: Socket, head: Buffer) => {
        this.handleUpgrade(req, socket, head).catch((err: unknown) => {
          this.logger.error(
            `Unhandled error in WS upgrade handling: ${String((err as Error)?.message ?? err)}`,
          );
          try {
            socket.destroy();
          } catch {
            // Already gone.
          }
        });
      },
    );
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const host = firstHeaderValue(req.headers, 'host') ?? '';
    const url = new URL(req.url ?? '/', `http://${host || 'invalid'}`);

    // 1. Route check first, and a SILENT destroy on a miss — this is not
    // our route, so we must not confirm or deny that `/ws/term` exists.
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    // 2. Origin check (F113). This is the CSRF defence for the upgrade —
    // upgrades are not subject to CORS, so without this an evil.com page
    // could open the socket and it would still arrive identity-headers-
    // attached.
    const expectedOrigin = `http://${host}`;
    if (!isSameOriginUpgrade(req.headers, expectedOrigin)) {
      rejectUpgrade(socket, 403, 'HTTP_403', 'Forbidden');
      return;
    }

    // 3. Session id shape.
    const id = url.searchParams.get('id') ?? '';
    if (!SESSION_ID_RE.test(id)) {
      rejectUpgrade(
        socket,
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'id must match /^wui-[0-9a-f]{12}$/',
      );
      return;
    }

    // 4. Identity: tailscale-user-login header first, else a single-use
    // ticket scoped to this exact session id (F114).
    const headerLogin = normalizeLogin(req.headers['tailscale-user-login']);
    let login: string | null = headerLogin;
    if (login === null) {
      const ticket = url.searchParams.get('ticket');
      if (ticket !== null) {
        const consumed = this.ticketService.consume(ticket);
        if (consumed === null || consumed.sessionId !== id) {
          rejectUpgrade(
            socket,
            401,
            ERROR_CODES.TICKET_INVALID,
            'Ticket is invalid, expired, already used, or scoped to a different terminal',
          );
          return;
        }
        login = consumed.login;
      }
    }
    if (login === null) {
      rejectUpgrade(
        socket,
        401,
        ERROR_CODES.AUTH_REQUIRED,
        'Authentication required',
      );
      return;
    }

    // 5. Allowlist — re-checked here on purpose even on the header path:
    // the allowlist can change between a ticket being minted and the
    // socket actually connecting, or between page load and reconnect.
    const allowed = await this.usersService.isAllowed(login);
    if (allowed === null) {
      rejectUpgrade(socket, 403, ERROR_CODES.NOT_ALLOWED, 'Not allowed');
      return;
    }

    // 6. Terminal must exist. `list()` doubles as the existence check and
    // the source of `cwd`/`mode` for the `ready` message, avoiding a
    // second round trip to tmux.
    const sessions = await this.tmuxService.list();
    const session = sessions.find((s) => s.name === id);
    if (!session) {
      rejectUpgrade(
        socket,
        404,
        ERROR_CODES.TERMINAL_NOT_FOUND,
        `Terminal not found: ${id}`,
      );
      return;
    }

    const context: AttachContext = {
      sessionName: id,
      cwd: this.workspacePathService.toRelative(session.cwd),
      mode: session.mode,
    };

    // 7. All checks passed — complete the handshake.
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleConnection(ws, context);
    });
  }

  /**
   * Per-connection state machine. The PTY is spawned only once a valid
   * `attach` control message arrives — never eagerly on `connection` — so
   * an aborted handshake (the client opens the socket and vanishes) never
   * leaks a `tmux attach-session` process.
   */
  private handleConnection(ws: WebSocket, context: AttachContext): void {
    let attached = false;
    let proc: IPty | null = null;
    let coalescer: OutputCoalescer | null = null;
    let disposed = false;

    const cleanup = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      coalescer?.dispose();
      if (proc) {
        try {
          proc.kill();
        } catch {
          // Already exited.
        }
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!attached) {
        if (isBinary) {
          sendJson(ws, {
            type: 'error',
            code: ERROR_CODES.VALIDATION_ERROR,
          });
          ws.close(1008, 'first message must be a JSON attach frame');
          return;
        }
        const attach = parseAttach(safeParseJson(data));
        if (!attach) {
          sendJson(ws, {
            type: 'error',
            code: ERROR_CODES.VALIDATION_ERROR,
          });
          ws.close(1008, 'invalid attach frame');
          return;
        }

        attached = true;
        proc = this.ptyService.spawn({
          sessionName: context.sessionName,
          cols: attach.cols,
          rows: attach.rows,
        });

        coalescer = new OutputCoalescer({
          send: (buf) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(buf, { binary: true });
            }
          },
          bufferedAmount: () => ws.bufferedAmount,
          pause: () => proc?.pause(),
          resume: () => proc?.resume(),
        });

        proc.onData((chunk) => {
          // LOAD-BEARING QUIRK (F111): `chunk` is typed `string` by
          // `@lydell/node-pty`'s `.d.ts` but is a raw `Buffer` at runtime
          // because PtyService spawns with `encoding: null`. Trusting the
          // type here would run it through an implicit UTF-8 re-encode and
          // corrupt binary pane output.
          coalescer?.push(chunk as unknown as Buffer);
        });

        proc.onExit(({ exitCode }) => {
          // Flush before reporting the exit. The last unflushed batch is
          // usually the only explanation the user will ever get for why the
          // terminal died -- a tmux usage error, a shell's final stderr --
          // and closing on top of it makes a failing session look like it
          // produced no output at all.
          coalescer?.flushPending();
          sendJson(ws, { type: 'exit', exitCode });
          ws.close(1000, 'pty exited');
        });

        sendJson(ws, {
          type: 'ready',
          session: context.sessionName,
          cwd: context.cwd,
          mode: context.mode,
        });
        return;
      }

      if (isBinary) {
        // Same reverse quirk: `write` is typed to take a `string`, but the
        // underlying stream accepts a `Buffer` directly, avoiding a
        // round-trip re-encode of raw client keystrokes/paste bytes.
        proc?.write(toBuffer(data) as unknown as string);
        return;
      }

      const parsed = safeParseJson(data);
      const resize = parseResize(parsed);
      if (resize) {
        proc?.resize(resize.cols, resize.rows);
        return;
      }
      if (isPingMessage(parsed)) {
        sendJson(ws, { type: 'pong' });
      }
    });
  }
}

function safeParseJson(data: RawData): unknown {
  try {
    return JSON.parse(toBuffer(data).toString('utf8'));
  } catch {
    return null;
  }
}
