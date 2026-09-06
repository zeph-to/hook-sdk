import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CONFIG_DIR = join(homedir(), '.zeph');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface ZephConfig {
  apiKey?: string;
  hookId?: string;
  baseUrl?: string;
  wsUrl?: string;
  deviceId?: string;
  /** `false` stops the listener holding the Mac awake on AC (`caffeinate -s`). README § Listener Options. */
  keepAwake?: boolean;
}

export const resolvedEnv = (key: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const val = env[key];
  return val && !val.startsWith('${') ? val : undefined;
};

/**
 * The two-way hook id: `ZEPH_HOOK_ID` when it carries a real value, else
 * `hookId` from ~/.zeph/config.json — what `zeph setup` writes. The plugin's
 * gate.sh `zeph_hook_id` and the MCP server resolve it in the same order.
 */
export const resolveHookId = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  resolvedEnv('ZEPH_HOOK_ID', env) || loadConfig().hookId;

// Per-agent project-dir env vars, in precedence order. Deliberately NOT part
// of the remote-agent registry: Cursor/Windsurf carry project-dir envs but
// are not remote-controllable via tmux — the two tables have different
// membership.
export const PROJECT_DIR_ENV_VARS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

/** First set project-dir env (unresolved `${VAR}` placeholders ignored), else cwd. */
export const detectProjectDir = (): string => {
  for (const key of PROJECT_DIR_ENV_VARS) {
    const val = resolvedEnv(key);
    if (val) return val;
  }
  return process.cwd();
};

export const loadConfig = (): ZephConfig => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as ZephConfig;
  } catch {
    return {};
  }
};

export const saveConfig = (config: ZephConfig): void => {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // `mode` only applies on creation — tighten pre-existing installs too,
  // since this file holds the API key.
  chmodSync(CONFIG_FILE, 0o600);
};

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();
