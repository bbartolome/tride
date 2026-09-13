import { WebuiConfigService } from './webui-config.service';

describe('WebuiConfigService', () => {
  const ENV_KEYS = [
    'WEBUI_PORT',
    'WEBUI_WORKSPACE_ROOT',
    'WEBUI_ADMIN_LOGINS',
    'WEBUI_STATE_DIR',
    'WEBUI_TMUX_SOCKET',
    'WEBUI_TMUX_CONF',
    'HOME',
  ] as const;

  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('applies defaults when no WEBUI_* env vars are set', () => {
    process.env.HOME = '/home/dev';
    const service = new WebuiConfigService();

    expect(service.config).toEqual({
      port: 8088,
      workspaceRoot: '/home/dev/workspace',
      adminLogins: new Set(),
      stateDir: '/var/lib/devcontainer-webui',
      tmuxSocket: 'webui',
      tmuxConfPath: '/etc/devcontainer/webui-tmux.conf',
    });
  });

  it('reads and parses every WEBUI_* env var', () => {
    process.env.WEBUI_PORT = '9090';
    process.env.WEBUI_WORKSPACE_ROOT = '/srv/ws';
    process.env.WEBUI_ADMIN_LOGINS =
      'Alice@Example.com, bob@example.com ,alice@example.com';
    process.env.WEBUI_STATE_DIR = '/tmp/state';
    process.env.WEBUI_TMUX_SOCKET = 'devsocket';
    process.env.WEBUI_TMUX_CONF = '/tmp/custom-tmux.conf';

    const service = new WebuiConfigService();

    expect(service.config.port).toBe(9090);
    expect(service.config.workspaceRoot).toBe('/srv/ws');
    expect(service.config.stateDir).toBe('/tmp/state');
    expect(service.config.tmuxSocket).toBe('devsocket');
    expect(service.config.tmuxConfPath).toBe('/tmp/custom-tmux.conf');
    // trimmed, lowercased, deduped
    expect(service.config.adminLogins).toEqual(
      new Set(['alice@example.com', 'bob@example.com']),
    );
  });

  it('falls back to the default port on a non-numeric WEBUI_PORT', () => {
    process.env.WEBUI_PORT = 'not-a-number';
    const service = new WebuiConfigService();
    expect(service.config.port).toBe(8088);
  });

  it('returns a frozen config object', () => {
    const service = new WebuiConfigService();
    expect(Object.isFrozen(service.config)).toBe(true);
  });
});
