import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

/**
 * Short-lived, single-use tickets for the WebSocket attach fallback (F114):
 * if Tailscale Serve turns out not to forward identity headers through a WS
 * upgrade, the client instead does `POST /api/terminals/:id/ticket` (behind
 * the ordinary CSRF + auth guards) and passes the returned token as
 * `?ticket=` on the socket URL. T18's upgrade handler then requires the
 * ticket's `sessionId` to match the socket's `?id=`.
 *
 * In-memory only, `Map<token, entry>` — there is exactly one Nest process,
 * so nothing here needs to survive a restart, and persisting a short-lived
 * secret to disk would be pure downside.
 */
export interface ConsumedTicket {
  login: string;
  sessionId: string;
}

interface TicketEntry extends ConsumedTicket {
  expiresAt: number;
}

export interface MintedTicket {
  ticket: string;
  expiresAt: number;
}

const TTL_MS = 30_000;

@Injectable()
export class TerminalTicketService {
  private readonly tickets = new Map<string, TicketEntry>();

  /**
   * Mints a fresh ticket scoped to one `sessionId`. Minting itself requires
   * passing `SameOriginGuard` (this route sits behind the global guards),
   * which is what stops `evil.com` minting one on the victim's behalf — see
   * F114.
   */
  mint(login: string, sessionId: string): MintedTicket {
    this.sweep();
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TTL_MS;
    this.tickets.set(ticket, { login, sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * Single-use: the entry is deleted on read regardless of outcome, so a
   * replayed or guessed token never succeeds twice — even if it was still
   * within its TTL the first time. Returns `null` for an unknown, already-
   * consumed, or expired token.
   */
  consume(ticket: string): ConsumedTicket | null {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      return null;
    }
    return { login: entry.login, sessionId: entry.sessionId };
  }

  /**
   * Opportunistic cleanup only — called on every mint, never on an interval
   * (F32: an interval left running is a Jest open-handle hang unless
   * cleared in `OnModuleDestroy`, and a single Nest process mints few enough
   * tickets that "sweep when something happens" is plenty).
   */
  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tickets) {
      if (entry.expiresAt <= now) {
        this.tickets.delete(token);
      }
    }
  }
}
