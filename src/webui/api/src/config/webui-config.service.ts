import { Injectable } from '@nestjs/common';

export interface WebuiConfig {
  port: number;
  workspaceRoot: string;
  adminLogins: Set<string>;
  stateDir: string;
  tmuxSocket: string;
  tmuxConfPath: string;
  /**
   * Absolute path to the built Angular `browser/` output to serve as static
   * assets, or `null` to fall back to the Docker image's flattened layout
   * (`join(__dirname, '..', '..', 'web', 'browser')` in app.module.ts).
   * Needed because running `node dist/main.js` straight from
   * `src/webui/api` on the host (rather than inside the built container
   * image) puts the real Angular output two path segments away, at
   * `src/webui/web/dist/web/browser` — this override is what lets host-only
   * manual verification (and any future non-container deployment) point at
   * the real location without touching code.
   */
  staticRoot: string | null;
  /**
   * Whether TailscaleAuthGuard enforces the identity/allowlist check.
   * Defaults to `false`: out of the box the web UI trusts anything that can
   * reach it, matching the "no ports, no auth, just the tailnet" deployment
   * model. Set WEBUI_REQUIRE_AUTH=true to restore the identity/allowlist
   * gate described in the README's security note.
   */
  requireAuth: boolean;
}

const DEFAULT_PORT = 8088;
const DEFAULT_STATE_DIR = '/var/lib/devcontainer-webui';
const DEFAULT_TMUX_SOCKET = 'webui';
const DEFAULT_TMUX_CONF_PATH = '/etc/devcontainer/webui-tmux.conf';

function parsePort(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function parseAdminLogins(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set<string>();
  }
  const logins = raw
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0);
  return new Set(logins);
}

@Injectable()
export class WebuiConfigService {
  private readonly _config: Readonly<WebuiConfig>;

  constructor() {
    const home = process.env.HOME ?? '/root';
    this._config = Object.freeze({
      port: parsePort(process.env.WEBUI_PORT),
      workspaceRoot: process.env.WEBUI_WORKSPACE_ROOT ?? `${home}/workspace`,
      adminLogins: parseAdminLogins(process.env.WEBUI_ADMIN_LOGINS),
      stateDir: process.env.WEBUI_STATE_DIR ?? DEFAULT_STATE_DIR,
      tmuxSocket: process.env.WEBUI_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET,
      tmuxConfPath: process.env.WEBUI_TMUX_CONF ?? DEFAULT_TMUX_CONF_PATH,
      staticRoot: process.env.WEBUI_STATIC_ROOT ?? null,
      requireAuth: parseBoolean(process.env.WEBUI_REQUIRE_AUTH, false),
    });
  }

  get config(): Readonly<WebuiConfig> {
    return this._config;
  }
}
