// Dev-server proxy for `ng serve --proxy-config proxy.conf.js`.
//
// Two things the backend needs that a plain proxy doesn't give it for free:
//
// 1. An identity header. In production, Tailscale Serve injects
//    `Tailscale-User-Login` before a request ever reaches Nest
//    (`IdentityMiddleware`, see src/webui/api/src/auth/identity.middleware.ts).
//    There is no Tailscale in front of `ng serve`, so this proxy injects it
//    itself — override the login via the `WEBUI_DEV_LOGIN` env var (must be
//    on `WEBUI_ADMIN_LOGINS`/the users store for the API to accept it).
//
// 2. A same-origin `Origin` header. `SameOriginGuard`
//    (src/webui/api/src/auth/same-origin.guard.ts) computes
//    `expectedOrigin` as `http://` + the request's own `Host` header — this
//    is the app's whole CSRF defence (F22), and it runs on every mutation.
//    With `changeOrigin: true` below, the proxy rewrites the `Host` header
//    it sends to the API to match the API's own host (127.0.0.1:<port>),
//    but the browser's real `Origin` header (http://localhost:4200, the
//    dev-server's own origin) rides along unchanged — so without
//    correcting it, `expectedOrigin` (derived from the rewritten Host)
//    and the incoming `Origin` header disagree and every mutation 403s.
//    The fix is to force `Origin` to match the *rewritten* Host, not the
//    browser's original one.
//
// Angular's dev-server builder (`@angular/build:dev-server`) runs on Vite,
// which normalizes proxy config into Vite's own proxy shape — built on
// node `http-proxy` directly, not `http-proxy-middleware`. That means the
// hook is `configure: (proxy) => proxy.on('proxyReq', ...)` (and
// `proxyReqWs` for the WebSocket upgrade), NOT http-proxy-middleware's
// `onProxyReq`/`onProxyReqWs` options — those are silently ignored under
// Vite.

const API_TARGET = `http://127.0.0.1:${process.env['WEBUI_API_PORT'] ?? '8088'}`;
const DEV_LOGIN = process.env['WEBUI_DEV_LOGIN'] ?? 'dev@example.com';

/** Rewrites `Origin` to match the (already `changeOrigin`-rewritten) `Host`
 * header on the outgoing proxied request, and injects the dev identity
 * header. Shared between the plain-HTTP and WebSocket-upgrade proxy
 * requests, since both need the same two corrections. */
function fixHeaders(proxyReq) {
  const rewrittenHost = proxyReq.getHeader('host');
  if (rewrittenHost) {
    proxyReq.setHeader('Origin', `http://${rewrittenHost}`);
  }
  proxyReq.setHeader('Tailscale-User-Login', DEV_LOGIN);
}

/** @type {import('@angular/build').ProxyConfig} */
module.exports = {
  '/api': {
    target: API_TARGET,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => fixHeaders(proxyReq));
    },
  },
  '/healthz': {
    target: API_TARGET,
    changeOrigin: true,
  },
  '/ws': {
    target: API_TARGET,
    changeOrigin: true,
    ws: true,
    configure: (proxy) => {
      proxy.on('proxyReqWs', (proxyReq) => fixHeaders(proxyReq));
    },
  },
};
