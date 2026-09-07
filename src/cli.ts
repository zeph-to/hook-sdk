#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { ZephHook } from './zeph-hook.js';
import { AuthenticationError, QuotaExceededError, ZephError } from './errors.js';
import { handleInstall } from './installer.js';
import { handleLogin } from './login.js';
import { handleUninstall } from './uninstall.js';
import { handleVerify } from './verify.js';
import { handleCheckUpdate } from './check-update.js';
import { handleAsk } from './ask.js';
import { handleAgentSession } from './wrapper.js';
import { handleMcp } from './mcp.js';
import { handleListener, computeListenerDeviceId } from './listener.js';
import { detectProjectDir, loadConfig, resolvedEnv, VERSION } from './config.js';
import {
  autoPushMode, decidePush, GATE_DEFAULTS, isMuted, NONREADONLY_COUNT_FLAG, normalizeMarker,
  PUSHMODE_DEFAULT_FLAG, TOOL_COUNT_FLAG,
} from './gate.js';
import { findAgentBySubcommand, REMOTE_AGENTS } from './remote-agents.js';
import { isRemoteHookAgent, runRemoteHook } from './remote-hook.js';

const detectBranchAndProject = (): { branch?: string; project: string } => {
  const dir = detectProjectDir();
  const project = dir.split('/').filter(Boolean).pop() ?? 'project';
  let branch: string | undefined;
  try {
    branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!branch || branch === 'HEAD') branch = undefined;
  } catch { /* not a git repo */ }
  return { branch, project };
};

// ── Arg Parser ──────────────────────────────────────────────────

const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const result: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];

    if (!next || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      i++;
    }
  }

  result._command = positional[0] ?? '';
  result._arg1 = positional[1] ?? '';

  return result;
};

// ── Output ──────────────────────────────────────────────────────

/** One usage line per registered remote agent — generated so help text can't drift from the table. */
const usageAgentLines = (): string =>
  REMOTE_AGENTS.map(
    (a) => `  ${`${a.subcommands[0]} [args…]`.padEnd(15)} Run '${a.binary}' in a named tmux session ('zeph-<project>')`,
  ).join('\n');

const printUsage = () => {
  console.log(`Usage: zeph <command> [options]

Commands:
  install         One-command setup: detect agents, save config, install rules
  login           Browser sign-in: auto-fetch API key + hook into ~/.zeph/config.json
  uninstall       Remove Zeph from all detected agents
  verify          Check installation health across detected agents
  check-update    Check whether a newer Zeph version is available
  notify          Send a push notification
  ask             Ask the phone a question and WAIT for the answer
                  (--title, --body, --actions id:Label,…, --timeout secs)
                  Prints one JSON line; exit 0 answered, 1 not. Built for
                  hooks, which cannot call the MCP zeph_ask tool.
  list            List recent push notifications
  dismiss <id>    Dismiss a push notification (or --all)
  rename <name>   Set this agent session's display name in the app
                  (run inside a zeph cc session; --clear resets it)
  test            Send a test notification to verify setup
${usageAgentLines()}
                  (reattaches a detached session of that project when
                   there is one, newest suffix first; auto-suffixes
                   -2/-3/… only when every existing one has a client
                   attached. Any args after the subcommand are forwarded
                   verbatim, e.g. 'zeph cc --resume')
  mcp             Run the MCP server on stdio. This is what agent MCP
                  configs launch — 'zeph install' registers it, you
                  never type it
  listener        Resident daemon — receives 'agent.command' pushes from
                  the phone picker and injects them into the matching
                  tmux session.
                  --stop     stop the running daemon
                  --restart  stop it and relaunch in the background
                             (needed after an upgrade: 'npm i -g' swaps
                              the package but never the live process)
                  --install-service
                             start the listener at every login (macOS
                             launchd). Without it the daemon only exists
                             after a 'zeph cc', so a reboot leaves the
                             phone picker empty until you open a terminal
                  --uninstall-service
                             remove the login-time service
                  --service-status
                             show what the installed service points at
                  --no-keep-awake
                             don't hold the Mac awake on AC power
                             (macOS; default runs 'caffeinate -s' so an
                              idle Mac keeps the socket up)

Notify options:
  --title <text>     Push title
  --body <text>      Push body
  --url <url>        URL to include
  --type <type>      Push type (note|link|file|hook) [default: hook]
  --priority <p>     Priority (low|normal|high|urgent) [default: normal]
  --device <id>      Target device ID
  --session <id>     AI session ID (or set ZEPH_SESSION_ID env)
  --auto             Apply the push gate before sending (honors the
                     /zeph-quiet | /zeph-loud dial; silent exit when gated)
  --pushmode-default <m>
                     Mode --auto assumes when the project has no dial
                     (quiet|normal|loud) [default: quiet]. A dial set with
                     /zeph-quiet | /zeph-loud | /zeph-normal always wins
  --marker <m>       Push Signal marker for --auto (skip|push|high)
  --tools <n>        Turn tool count for --auto [default: assume real work]
  --nonreadonly <n>  Non-read-only tool count for --auto

List options:
  --limit <n>        Number of pushes (1-20, default 5)
  --type <type>      Filter by push type

Dismiss options:
  --all              Dismiss all notifications

Login options:
  --web-url <url>    Web app URL to sign in at [default: https://app.zeph.to]
  --timeout <sec>    Seconds to wait for the browser [default: 300]

Install options:
  (no --key, no saved config → opens browser login automatically;
   a saved login is reused untouched on re-run; headless falls back
   to manual key entry)
  --key <api-key>    API key (non-interactive; skips browser login)
  --hook <hook-id>   Hook ID (non-interactive)
  --service          Install the login-time listener service without
                     asking (macOS). Interactive runs offer it anyway;
                     scripted runs need this flag
  --no-service       Never install it
  --base-url <url>   Base URL (non-interactive)
  --relogin          Force a fresh browser sign-in even if a login is
                     already saved (switch account)
  --web-url <url>    Login web app URL [default: https://app.zeph.to]
  --only <agents>    Comma-separated agent ids to install for
                     (claude,cursor,windsurf,gemini,codex,copilot,cline,aider).
                     Skips the interactive picker.

Uninstall options:
  --dry-run          Preview what would be removed, change nothing
  --purge            Also delete ~/.zeph/config.json (kept by default)

Verify options:
  --ping             Also make a live API call to confirm the key works

Global options:
  --key <api-key>    API key (or set ZEPH_API_KEY env)
  --base-url <url>   API base URL (or set ZEPH_BASE_URL env)
  --json             Output JSON format
  --version          Show version

Environment:
  ZEPH_API_KEY       API key (fallback when --key not provided)
  ZEPH_BASE_URL      API base URL (fallback when --base-url not provided)
  ZEPH_SESSION_ID    AI session ID (fallback when --session not provided)`);
};

const printError = (message: string, isJson: boolean) => {
  if (isJson) {
    console.error(JSON.stringify({ error: message, status: 'error' }));
  } else {
    console.error(`Error: ${message}`);
  }
};

const printJson = (data: unknown) => {
  console.log(JSON.stringify(data, null, 2));
};

// ── Commands ────────────────────────────────────────────────────

const createHook = (args: Record<string, string | boolean>): ZephHook | null => {
  const config = loadConfig();
  const apiKey = (args.key as string) || resolvedEnv('ZEPH_API_KEY') || config.apiKey;
  const isJson = args.json === true;

  if (!apiKey) {
    printError('API key required. Run "zeph install" or set ZEPH_API_KEY', isJson);
    return null;
  }

  const baseUrl = (args['base-url'] as string) || resolvedEnv('ZEPH_BASE_URL') || config.baseUrl;

  return new ZephHook({
    apiKey,
    ...(baseUrl && { baseUrl }),
  });
};

/** Current tmux session name (the rename key), or null when not inside tmux. */
const detectCurrentTmuxSession = (): string | null => {
  if (!process.env.TMUX) return null;
  try {
    const name = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8' }).trim();
    return name || null;
  } catch {
    return null;
  }
};

/**
 * `zeph rename "<name>"` — set THIS agent session's display name in the app.
 * Auto-detects the current tmux session + this machine's listener device id
 * (`computeListenerDeviceId`, the same id the listener registers, so the
 * rename lands on the right device). `--clear` resets to the computed label.
 */
const handleRename = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const clearing = args.clear === true;
  const alias = (args._arg1 as string) || '';
  if (!alias && !clearing) {
    printError('Usage: zeph rename "New name"  (or --clear to reset to default)', isJson);
    return 2;
  }

  const sessionName = (args.session as string) || detectCurrentTmuxSession();
  if (!sessionName) {
    printError('No tmux session detected. Run inside a `zeph cc` session, or pass --session <name>.', isJson);
    return 2;
  }
  const deviceId = (args.device as string) || computeListenerDeviceId();

  const hook = createHook(args);
  if (!hook) return 3;

  try {
    await hook.renameAgentSession(deviceId, sessionName, clearing ? '' : alias);
    if (isJson) printJson({ session: sessionName, alias: clearing ? null : alias, status: 'ok' });
    else console.log(clearing ? `Reset name for ${sessionName}` : `Renamed ${sessionName} → ${alias}`);
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

/** Parse a gate count flag; garbage input falls back to the default (never accidentally silences). */
const gateCount = (raw: string | boolean | undefined, fallback: number): number => {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Internal — invoked by the Gemini/Codex prompt-submit hooks that
 * `zeph setup` registers, never typed by users (hence absent from help).
 * Reads the hook JSON on stdin; prints additionalContext JSON on a match
 * (remote-origin detection, ADR-0002). Always exits 0: the hook only adds
 * context and must never block a prompt.
 */
const handleRemoteHook = async (args: Record<string, string | boolean>): Promise<number> => {
  const agent = args._arg1 as string;
  if (!isRemoteHookAgent(agent)) return 0;
  try {
    let stdin = '';
    for await (const chunk of process.stdin) stdin += chunk;
    const out = runRemoteHook(agent, stdin);
    if (out) console.log(out);
  } catch {
    /* never block a prompt */
  }
  return 0;
};

const handleNotify = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const projectDir = detectProjectDir();
  if (isMuted(projectDir)) return 0;

  // --auto: apply the shared push-gate before sending. Inputs default to
  // GATE_DEFAULTS ("assume real work") so dumb hooks keep their historical
  // always-push behavior in normal mode, while the /zeph-quiet | /zeph-loud
  // dial now works for every hook-driven agent. Gated-out → silent success.
  // With no dial the mode falls back to --pushmode-default, then to quiet.
  if (args.auto === true) {
    const verdict = decidePush({
      toolCount: gateCount(args[TOOL_COUNT_FLAG], GATE_DEFAULTS.toolCount),
      nonReadonlyCount: gateCount(args[NONREADONLY_COUNT_FLAG], GATE_DEFAULTS.nonReadonlyCount),
      alreadyAsked: GATE_DEFAULTS.alreadyAsked,
      marker: normalizeMarker(typeof args.marker === 'string' ? args.marker : undefined),
      pushMode: autoPushMode(projectDir, args[PUSHMODE_DEFAULT_FLAG]),
    });
    if (!verdict.push) return 0;
    if (verdict.priority === 'high' && !args.priority) args.priority = 'high';
  }

  const hook = createHook(args);
  if (!hook) return 3;

  try {
    const sessionId = (args.session as string | undefined) || resolvedEnv('ZEPH_SESSION_ID') || undefined;

    // When body isn't supplied (common case for hook-driven invocations like
    // `zeph notify --title "Task done"`), auto-fill with branch + project so
    // the user can tell which session finished without opening the app.
    let title = args.title as string | undefined;
    let body = args.body as string | undefined;
    if (!body) {
      const { branch, project } = detectBranchAndProject();
      body = branch ? `${project} · ${branch}` : project;
    }
    if (!title) title = 'Task done';

    const result = await hook.notify({
      title,
      body,
      url: args.url as string | undefined,
      type: (args.type as 'note' | 'link' | 'file' | 'hook') || 'hook',
      priority: (args.priority as 'low' | 'normal' | 'high' | 'urgent') || undefined,
      targetDeviceId: args.device as string | undefined,
      sessionId,
    });

    if (isJson) {
      printJson({ pushId: result.pushId, status: 'ok' });
    } else {
      console.log(`Push sent: ${result.pushId}`);
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleList = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    // Clamp to the documented 1-20 range; a non-numeric value falls back to
    // the server default instead of sending limit=NaN in the query string.
    const rawLimit = args.limit ? Number(args.limit) : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.min(20, Math.max(1, Math.floor(rawLimit))) : undefined;
    const result = await hook.list({
      limit,
      type: args.type as 'note' | 'link' | 'file' | 'clipboard' | 'hook' | undefined,
    });

    if (isJson) {
      printJson(result);
    } else {
      if (result.pushes.length === 0) {
        console.log('No pushes found.');
      } else {
        for (const p of result.pushes) {
          const title = p.title ?? '(no title)';
          const time = new Date(p.createdAt).toLocaleString();
          console.log(`  ${p.pushId}  [${p.type}]  ${title}  (${time})`);
        }
        if (result.hasMore) console.log(`  ... more available (use --limit to increase)`);
      }
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleDismiss = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    if (args.all === true) {
      const result = await hook.dismissAll();
      if (isJson) {
        printJson({ dismissed: result.dismissed, status: 'ok' });
      } else {
        console.log(`Dismissed ${result.dismissed} pushes.`);
      }
    } else {
      const pushId = args._arg1 as string;
      if (!pushId) {
        printError('Push ID required. Usage: zeph dismiss <push-id> or zeph dismiss --all', isJson);
        return 1;
      }
      await hook.dismiss(pushId);
      if (isJson) {
        printJson({ dismissed: true, pushId, status: 'ok' });
      } else {
        console.log(`Dismissed: ${pushId}`);
      }
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleTest = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    const result = await hook.notify({
      title: 'Zeph Test',
      body: `CLI connected successfully (v${VERSION})`,
    });

    if (isJson) {
      printJson({ pushId: result.pushId, status: 'ok', message: 'Test notification sent' });
    } else {
      console.log(`Test notification sent: ${result.pushId}`);
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

// ── Error Handler ───────────────────────────────────────────────

const handleError = (err: unknown, isJson: boolean): number => {
  if (err instanceof QuotaExceededError) {
    printError(err.message, isJson);
    return 2;
  }
  if (err instanceof AuthenticationError) {
    printError(err.message, isJson);
    return 3;
  }
  if (err instanceof ZephError) {
    printError(err.message, isJson);
    return 1;
  }
  printError(err instanceof Error ? err.message : 'Unknown error', isJson);
  return 1;
};

// ── Passthrough ─────────────────────────────────────────────────

/**
 * Collect raw argv after the given subcommand token so flags like
 * `--resume` reach the wrapped agent verbatim instead of being swallowed
 * by `parseArgs`. Returns [] when the command isn't found.
 */
const collectPassthrough = (argv: string[], cmd: string): string[] => {
  const idx = argv.indexOf(cmd, 2);
  return idx >= 0 ? argv.slice(idx + 1) : [];
};

// ── Main ────────────────────────────────────────────────────────

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv);
  const command = args._command as string;

  if (args.version === true) {
    console.log(VERSION);
    return 0;
  }

  if (!command || command === 'help') {
    printUsage();
    return 0;
  }

  // Remote-control subcommands (`zeph cc` / `zeph codex` / …) come from the
  // registry — one table row per agent, no hardcoded cases. Pass the typed
  // command token to collectPassthrough (aliases map to the same agent).
  const remote = findAgentBySubcommand(command);
  if (remote) return handleAgentSession(remote, collectPassthrough(process.argv, command));

  switch (command) {
    case 'install':
    case 'setup':
      return handleInstall(args);
    case 'login':
      return handleLogin(args);
    case 'uninstall':
      return handleUninstall(args);
    case 'verify':
      return handleVerify(args);
    case 'check-update':
      return handleCheckUpdate(args);
    case 'notify':
      return handleNotify(args);
    case 'ask':
      return handleAsk(args);
    case 'list':
      return handleList(args);
    case 'dismiss':
      return handleDismiss(args);
    case 'rename':
      return handleRename(args);
    case 'test':
      return handleTest(args);
    case 'mcp':
      return handleMcp();
    case 'listener':
      return handleListener(args);
    case 'remote-hook':
      return handleRemoteHook(args);
    default:
      printError(`Unknown command: ${command}`, args.json === true);
      printUsage();
      return 1;
  }
};

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
