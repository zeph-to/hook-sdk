import { accessSync, constants, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { detectAgents, resolveCommand } from './agents.js';
import { loadConfig, resolvedEnv, resolveHookId, VERSION } from './config.js';
import { serviceHealthChecks, serviceStatus, type ServiceHealthRow } from './listener-service.js';
import { ZephHook } from './zeph-hook.js';
import { MCP_LAUNCH_ARGV } from './mcp-command.js';
import {
    LISTENER_LOG_FILE, runningListenerPid, runningListenerWsUrl as stampedListenerWsUrl,
} from './listener-process.js';
import {
    DEFAULT_API_BASE, endpointStage, legacyWsEnvNotice, parseListenerStartUrl, resolveWsUrlDetailed,
    type WsUrlSource,
} from './ws-url.js';

const HOME = homedir();

const pass = (msg: string) => console.log(`    ✓ ${msg}`);
const warn = (msg: string) => console.log(`    ! ${msg}`);
const failMsg = (msg: string) => console.log(`    ✗ ${msg}`);

// The service health rows already carry exactly this shape, and every check
// here is recorded the same way — one declaration, not two kept in step by hand.
type Check = ServiceHealthRow;

/** Does a shared rule file contain the Zeph managed block? */
const hasManagedBlock = (filePath: string): boolean => {
    try {
        return readFileSync(filePath, 'utf-8').includes('ZEPH:START');
    } catch {
        return false;
    }
};

// Per-agent: report whether the rule artifact Zeph installs is present.
const AGENT_RULE_PRESENT: Record<string, () => boolean> = {
    claude: () => {
        try { return /zeph/.test(readFileSync(join(HOME, '.claude.json'), 'utf-8')); }
        catch { return existsSync(join(HOME, '.claude', 'plugins')); }
    },
    cursor: () => existsSync(join(HOME, '.cursor', 'rules', 'zeph.mdc')),
    windsurf: () => hasManagedBlock(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md')),
    gemini: () => hasManagedBlock(join(HOME, '.gemini', 'GEMINI.md')),
    codex: () => hasManagedBlock(join(HOME, '.codex', 'AGENTS.md')),
    copilot: () => existsSync(join(HOME, '.copilot', 'instructions', 'zeph.instructions.md')),
    cline: () => existsSync(join(HOME, '.cline', 'rules', 'zeph.md')),
    aider: () => existsSync(join(HOME, '.zeph', 'aider-conventions.md')),
    pi: () => hasManagedBlock(join(HOME, '.pi', 'agent', 'AGENTS.md')),
    opencode: () => hasManagedBlock(join(HOME, '.config', 'opencode', 'AGENTS.md')),
};

/**
 * Where each agent records the MCP launch, and under which container key.
 * `agent` matches the label `detectAgents` uses so one report never names the
 * same agent two ways. Cursor/Windsurf/OpenCode are files the installer writes
 * itself; the Gemini row is READ-ONLY — `zeph install` shells out to
 * `gemini mcp add`, so this path is the gemini CLI's own storage layout,
 * confirmed by reading the file it produced, not something Zeph chose.
 */
const MCP_REGISTRIES: ReadonlyArray<{ agent: string; path: string; key: string }> = [
    { agent: 'Cursor', path: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { agent: 'Windsurf', path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
    { agent: 'Gemini CLI', path: join(HOME, '.gemini', 'settings.json'), key: 'mcpServers' },
    { agent: 'OpenCode', path: join(HOME, '.config', 'opencode', 'opencode.json'), key: 'mcp' },
];

/**
 * The launch argv a registry file records for zeph, verbatim — null when the
 * file is absent, unparseable, or has no zeph entry. Two schemas in the wild:
 * `command` + `args` (Cursor/Windsurf/Gemini) and `command` as a whole array
 * (opencode). Returned as-is on purpose: a stale entry is only detectable if
 * the reader does not normalize it into the shape it expects.
 */
export const registeredMcpArgv = (filePath: string, key: string): string[] | null => {
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const container = data[key] as Record<string, unknown> | undefined;
    const entry = container?.zeph as { command?: unknown; args?: unknown } | undefined;
    if (!entry) return null;
    if (Array.isArray(entry.command)) return entry.command.map(String);
    if (typeof entry.command !== 'string') return null;
    return [entry.command, ...(Array.isArray(entry.args) ? entry.args.map(String) : [])];
};

/**
 * Can this launch binary actually be run? Registered commands come out of a
 * config file, so unlike everywhere else in the CLI they can be an absolute
 * path — `which` is the wrong question for one of those, hence the split.
 * The bare-name half is `resolveCommand`; neither half touches a shell, so a
 * path with a space in it stays one word and a `;` in the file stays inert.
 */
export const binaryResolves = (bin: string): boolean => {
    if (!bin.includes('/')) return resolveCommand(bin) !== null;
    try {
        accessSync(bin, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

/**
 * What a recorded registration is worth right now. `unresolvable` outranks
 * `stale`: a stale entry still starts a server (through the npm launcher this
 * release exists to delete), an unresolvable one starts nothing at all and
 * takes the agent's whole zeph toolset down with it, silently — the config is
 * read once at install time and never checked again.
 */
export type McpRegistration =
    | { readonly state: 'current' }
    | { readonly state: 'stale'; readonly argv: string[] }
    | { readonly state: 'unresolvable'; readonly argv: string[] };

/** null = this agent has no zeph registration at all, so there is nothing to report. */
export const classifyMcpRegistration = (
    argv: string[] | null,
    isOnPath: (bin: string) => boolean,
): McpRegistration | null => {
    if (!argv || argv.length === 0) return null;
    if (!isOnPath(argv[0])) return { state: 'unresolvable', argv };
    const isCanonical = argv.length === MCP_LAUNCH_ARGV.length
        && argv.every((token, i) => token === MCP_LAUNCH_ARGV[i]);
    return isCanonical ? { state: 'current' } : { state: 'stale', argv };
};

/** The registries that actually hold a zeph entry, classified. Agents that were
 *  never installed drop out here so the report has no row for them. */
const activeMcpRegistrations = (
    isOnPath: (bin: string) => boolean,
): Array<{ agent: string; result: McpRegistration }> =>
    MCP_REGISTRIES.flatMap((registry) => {
        const result = classifyMcpRegistration(registeredMcpArgv(registry.path, registry.key), isOnPath);
        return result ? [{ agent: registry.agent, result }] : [];
    });

/** Where a resolved WebSocket URL came from, in the user's terms. */
const WS_SOURCE_LABEL: Record<WsUrlSource, string> = {
    flag: '--ws-url',
    config: '~/.zeph/config.json',
    'env-deprecated': 'ZEPH_WS_URL (deprecated)',
    default: 'built-in default',
};

/**
 * The URL the live daemon connected to, or null when none is running.
 *
 * The stamp first; the log only as a fallback, for a daemon started by a build
 * that predates the stamp. Reading the log alone was not enough — it rotates at
 * 5MB, and the daemon whose startup line has been rotated away is precisely the
 * long-lived one whose config edit this check exists to catch.
 */
const liveListenerWsUrl = (): string | null => {
    if (runningListenerPid() === null) return null;
    const stamped = stampedListenerWsUrl();
    if (stamped) return stamped;
    try {
        return parseListenerStartUrl(readFileSync(LISTENER_LOG_FILE, 'utf-8'));
    } catch {
        return null;
    }
};

export const handleVerify = async (args: Record<string, string | boolean>): Promise<number> => {
    const doPing = args.ping === true;
    const checks: Check[] = [];
    const record = (label: string, state: Check['state']) => {
        checks.push({ label, state });
        if (state === 'pass') pass(label);
        else if (state === 'warn') warn(label);
        else failMsg(label);
    };

    console.log(`\n  Zeph verify — v${VERSION}\n`);

    // ── Credentials ──────────────────────────────────────────────
    console.log('  Credentials:');
    const config = loadConfig();
    const apiKey = resolvedEnv('ZEPH_API_KEY') || config.apiKey;
    const hookId = resolveHookId();
    record(apiKey ? 'ZEPH_API_KEY is set' : 'ZEPH_API_KEY not set (env or ~/.zeph/config.json)',
        apiKey ? 'pass' : 'fail');
    record(hookId
        ? 'ZEPH_HOOK_ID is set (two-way zeph_ask/prompt/input enabled)'
        : 'ZEPH_HOOK_ID not set (notify-only — set it for remote control)',
        hookId ? 'pass' : 'warn');

    // ── Runtime ──────────────────────────────────────────────────
    // One resolution per binary: `zeph` alone was being looked up five times
    // (twice here, once per registry below), and each lookup is a spawn.
    const resolved = new Map<string, boolean>();
    const resolves = (bin: string): boolean => {
        const cached = resolved.get(bin);
        if (cached !== undefined) return cached;
        const found = binaryResolves(bin);
        resolved.set(bin, found);
        return found;
    };

    console.log('\n  Runtime:');
    const hasNode = resolves('node');
    const hasNpx = resolves('npx');
    const hasZeph = resolves('zeph');
    record(hasNode ? 'node available' : 'node not found', hasNode ? 'pass' : 'fail');
    record(hasNpx ? 'npx available (hook fallback when zeph is off PATH)' : 'npx not found',
        hasNpx ? 'pass' : 'warn');
    // Not a warning any more: `zeph mcp` IS the MCP server, so a zeph that
    // isn't on PATH means no MCP tools at all, not just a slower first call.
    record(hasZeph
        ? 'zeph CLI on PATH (runs the MCP server and the hooks)'
        : 'zeph CLI not on PATH — MCP tools will not start. Reinstall: npm i -g @zeph-to/cli',
        hasZeph ? 'pass' : 'fail');

    // ── Login-time service ───────────────────────────────────────
    // Optional, so a missing one is a warning. A broken one is not: every way
    // it breaks still looks installed from the outside.
    const serviceRows = serviceHealthChecks(serviceStatus());
    if (serviceRows.length > 0) {
        console.log('\n  Login-time service:');
        for (const row of serviceRows) record(row.label, row.state);
    }

    // ── WebSocket ────────────────────────────────────────────────
    // The phone's Agents list is fed over this socket, so a machine on the
    // wrong stage is simply absent from the app with nothing to explain it.
    console.log('\n  WebSocket:');
    const wsBaseUrl = (args['base-url'] as string) || resolvedEnv('ZEPH_BASE_URL') || config.baseUrl || DEFAULT_API_BASE;
    const staleWsEnv = legacyWsEnvNotice(config);
    if (staleWsEnv) record(staleWsEnv.replace(/^zeph: /, ''), 'warn');
    const ws = resolveWsUrlDetailed(args, config, wsBaseUrl);
    if (!ws) {
        record('no WebSocket URL, and none can be guessed for a custom API base — set "wsUrl" in ~/.zeph/config.json', 'fail');
    } else {
        record(`${ws.url} (from ${WS_SOURCE_LABEL[ws.source]})`, 'pass');

        // Socket on one stage and REST on another splits the device: pushes go
        // one way, the agent list the other, and neither half looks broken.
        const wsStage = endpointStage(ws.url);
        const apiStage = endpointStage(wsBaseUrl);
        record(wsStage === apiStage
            ? `API base is the same stage (${apiStage})`
            : `stage mismatch — socket is ${wsStage}, API base is ${apiStage} (${wsBaseUrl}). Pushes and the agent list would land in different environments`,
            wsStage === apiStage ? 'pass' : 'warn');

        // The daemon reads this once, at startup. Editing the config does
        // nothing to a listener that has been up since before the edit — which
        // looks exactly like the config not being read at all.
        const live = liveListenerWsUrl();
        if (live && live !== ws.url) {
            record(`the running listener is on ${live}, not the resolved URL — restart it: zeph listener --restart`, 'warn');
        }
    }

    // ── MCP registrations ────────────────────────────────────────
    const registrations = activeMcpRegistrations(resolves);
    if (registrations.length > 0) {
        console.log('\n  MCP registrations:');
        for (const { agent, result } of registrations) {
            if (result.state === 'current') record(`${agent}: launches \`${MCP_LAUNCH_ARGV.join(' ')}\``, 'pass');
            else if (result.state === 'stale') {
                record(`${agent}: still launches \`${result.argv.join(' ')}\` — one extra resident process per session. Re-run: zeph install`, 'warn');
            } else {
                record(`${agent}: launches \`${result.argv[0]}\`, which is not on PATH — zeph tools will not load. Re-run: zeph install`, 'fail');
            }
        }
    }

    // ── Per-agent config ─────────────────────────────────────────
    console.log('\n  Agents:');
    const detected = detectAgents().filter((a) => a.detected);
    if (detected.length === 0) {
        warn('no supported agents detected');
    }
    for (const agent of detected) {
        const present = AGENT_RULE_PRESENT[agent.id]?.() ?? false;
        record(`${agent.name}: ${present ? 'Zeph rules installed' : 'Zeph rules NOT installed — run: zeph install'}`,
            present ? 'pass' : 'warn');
    }

    // ── Optional live API ping ───────────────────────────────────
    if (doPing) {
        console.log('\n  API ping:');
        if (!apiKey) {
            record('skipped — no API key', 'warn');
        } else {
            try {
                const hook = new ZephHook({ apiKey, ...(config.baseUrl && { baseUrl: config.baseUrl }) });
                await hook.list({ limit: 1 });
                record('API reachable, key accepted', 'pass');
            } catch (err) {
                record(`API call failed: ${err instanceof Error ? err.message : 'unknown'}`, 'fail');
            }
        }
    }

    // ── Summary ──────────────────────────────────────────────────
    const fails = checks.filter((c) => c.state === 'fail').length;
    const warns = checks.filter((c) => c.state === 'warn').length;
    console.log('');
    if (fails === 0 && warns === 0) {
        console.log('  ✓ All checks passed.\n');
    } else {
        console.log(`  ${fails} failed, ${warns} warnings.${doPing ? '' : ' (run with --ping to test the API)'}\n`);
    }
    return fails === 0 ? 0 : 1;
};
