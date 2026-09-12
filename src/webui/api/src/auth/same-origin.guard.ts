import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'http';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

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

/**
 * The CSRF defence for this API. Tailscale Serve injects the identity header
 * server-side, so a page on evil.com loaded in the user's browser can POST to
 * this API and it arrives fully authenticated — there are no cookies to
 * SameSite out of. This pure function is the whole check, exported so
 * `terminal.ws.ts` (Phase 3) can reuse it verbatim against WebSocket upgrade
 * headers instead of duplicating the logic — upgrades are not subject to
 * CORS, so this is what protects them too.
 *
 * Safe methods (GET/HEAD) are always allowed. Every other method requires:
 *  - header `X-Webui-Request: 1` (a cross-origin fetch cannot set a custom
 *    header without a CORS preflight, and this API emits no CORS headers, so
 *    the preflight fails)
 *  - `Origin`, when present, equal to the request's own origin
 *  - `Sec-Fetch-Site`, when present, one of `same-origin`/`none`
 */
export function isSameOriginRequest(
  headers: HeaderBag,
  method: string,
  expectedOrigin: string,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return true;
  }

  if (firstHeaderValue(headers, 'x-webui-request') !== '1') {
    return false;
  }

  const origin = firstHeaderValue(headers, 'origin');
  if (origin !== undefined && origin !== expectedOrigin) {
    return false;
  }

  const secFetchSite = firstHeaderValue(headers, 'sec-fetch-site');
  if (
    secFetchSite !== undefined &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  ) {
    return false;
  }

  return true;
}

@Injectable()
export class SameOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<IncomingMessage>();
    const host = firstHeaderValue(req.headers, 'host') ?? '';
    // The app is served plain HTTP only (see plan.md: "https://tride cannot
    // work" — Tailscale Serve terminates TLS and forwards HTTP), so the
    // scheme is always http.
    const expectedOrigin = `http://${host}`;
    return isSameOriginRequest(
      req.headers,
      req.method ?? 'GET',
      expectedOrigin,
    );
  }
}
