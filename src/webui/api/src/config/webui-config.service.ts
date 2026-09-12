import { Injectable } from '@nestjs/common';

export interface WebuiConfig {
  port: number;
  workspaceRoot: string;
  adminLogins: Set<string>;
  stateDir: string;
  tmuxSocket: string;
}

const DEFAULT_PORT = 8088;
const DEFAULT_STATE_DIR = '/var/lib/devcontainer-webui';
const DEFAULT_TMUX_SOCKET = 'webui';

function parsePort(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
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
    });
  }

  get config(): Readonly<WebuiConfig> {
    return this._config;
  }
}
