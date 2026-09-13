import { readFileSync, statSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';

// Matches the `SSH_AUTH_SOCK=<path>; export SSH_AUTH_SOCK;` line an SSH
// login's keychain/agent writes. `[^;]+` stops at the first `;`, which is
// safe: the socket path itself never legitimately contains one.
const SSH_AUTH_SOCK_LINE_RE = /SSH_AUTH_SOCK=([^;]+);/;

/**
 * Opportunistically resolves a usable `SSH_AUTH_SOCK` by reading the
 * keychain file an SSH login session writes at
 * `${HOME}/.keychain/${hostname()}-sh`.
 *
 * Must be called FRESH on every git fetch/pull/push request, never cached or
 * computed once at boot: the agent that owns the socket may be started by an
 * SSH login that happens well after this server started, and re-resolving
 * here on every call is exactly what makes push start working again without
 * a server restart.
 *
 * Every failure mode — the file is missing or unreadable, its content
 * doesn't match the expected export line, or the path it names doesn't
 * exist or isn't actually a Unix socket — resolves to `undefined` rather
 * than throwing. This is a best-effort lookup, never a hard requirement: a
 * command with no auth needs (or one already reachable via some other
 * mechanism) must proceed regardless.
 */
export function resolveSshAuthSock(): string | undefined {
  try {
    const home = process.env.HOME ?? '/root';
    const keychainFile = join(home, '.keychain', `${hostname()}-sh`);
    const contents = readFileSync(keychainFile, 'utf8');

    const match = SSH_AUTH_SOCK_LINE_RE.exec(contents);
    const candidate = match?.[1];
    if (!candidate || candidate.length === 0) {
      return undefined;
    }

    // Existence alone is not enough — a stale keychain entry can point at a
    // path since reused by something that is not a socket at all. Only a
    // real Unix socket is trustworthy here.
    if (!statSync(candidate).isSocket()) {
      return undefined;
    }

    return candidate;
  } catch {
    return undefined;
  }
}
