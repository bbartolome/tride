import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * The identity Tailscale Serve attaches to a request. `login` is the only
 * field ever used for authorization; `name` and `profilePicUrl` are
 * display-only and must never influence a guard's decision.
 */
export interface Identity {
  login: string;
  name?: string;
  profilePicUrl?: string;
  role?: 'admin' | 'user';
  seeded?: boolean;
}

// There is no @types/express in this package (see T1 finding F6): the
// request object Nest hands middleware/guards is, at runtime, an Express
// request, but it is structurally a Node http.IncomingMessage and every
// field this codebase touches (headers, method) lives there too. Augmenting
// the real, present `http` module via declaration merging avoids pulling in
// @types/express just for one field.
declare module 'http' {
  interface IncomingMessage {
    identity?: Identity | null;
  }
}

const MAX_HEADER_LEN = 254;
// eslint-disable-next-line no-control-regex -- deliberately matching control chars
const WHITESPACE_OR_CONTROL_RE = /[\s\x00-\x1f\x7f]/;

function headerToString(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? raw.join(',') : raw;
}

/**
 * Normalizes the principal header: trim, reject a comma anywhere (Node folds
 * duplicate headers into one comma-joined string, so a comma is exactly the
 * shape a header-injection/duplication attempt takes), reject whitespace or
 * control characters, cap at 254 chars, lowercase. Returns null on any
 * rejection or when the header is missing/empty — callers must never throw.
 */
export function normalizeLogin(
  raw: string | string[] | undefined,
): string | null {
  const value = headerToString(raw);
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.includes(',')) {
    return null;
  }
  if (WHITESPACE_OR_CONTROL_RE.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, MAX_HEADER_LEN).toLowerCase();
}

/**
 * Normalizes a display-only header: trim + cap only. These values are never
 * used for authorization, so odd content (commas, mixed case, emoji) is
 * carried through as-is rather than rejected.
 */
export function normalizeDisplayValue(
  raw: string | string[] | undefined,
): string | undefined {
  const value = headerToString(raw);
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().slice(0, MAX_HEADER_LEN);
  return trimmed.length > 0 ? trimmed : undefined;
}

@Injectable()
export class IdentityMiddleware implements NestMiddleware<
  IncomingMessage,
  ServerResponse
> {
  private readonly logger = new Logger(IdentityMiddleware.name);

  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    const rawLogin = req.headers['tailscale-user-login'];
    const login = normalizeLogin(rawLogin);

    if (login === null) {
      if (headerToString(rawLogin) !== undefined) {
        this.logger.warn(
          'Rejected tailscale-user-login header: empty, malformed, or contains a comma/whitespace/control character',
        );
      }
      req.identity = null;
      next();
      return;
    }

    const name = normalizeDisplayValue(req.headers['tailscale-user-name']);
    const profilePicUrl = normalizeDisplayValue(
      req.headers['tailscale-user-profile-pic'],
    );

    req.identity = {
      login,
      ...(name !== undefined ? { name } : {}),
      ...(profilePicUrl !== undefined ? { profilePicUrl } : {}),
    };
    next();
  }
}
