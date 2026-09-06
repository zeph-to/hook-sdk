/**
 * `zeph listener` — resident daemon that watches the user's Zeph feed
 * over a persistent WebSocket and injects matching messages into a
 * named tmux session via `tmux send-keys`.
 *
 * Solves the MCP polling-window problem: an `zeph_ask` polling cycle
 * times out (120–600 s) and the CC/Codex session becomes unaddressable
 * from the phone. The listener stays subscribed indefinitely and can
 * deliver to any named tmux session at any time.
 *
 * Wire format: pushes with `type='agent.command'` carry the tmux
 * session name in `agentSessionName` and the message in `body`. The
 * "AI Agent에게 명령" sheet on the phone builds these structured
 * pushes from the listener-reported session inventory. Other push
 * types (Stop-hook auto-pushes, zeph_ask responses, channel
 * broadcasts) are ignored.
 *
 * Transport: WebSocket against the Zeph $connect endpoint with
 * `?apiKey=<key>`. The server fan-out pushes `{ type: 'push.new', data }`
 * messages as new pushes are created. Reconnects with exponential
 * backoff on transient failures; gives up on auth failures (4001/4002/4003).
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join, basename, isAbsolute, resolve, sep } from 'path';
import WebSocket from 'ws';
import { loadConfig, resolvedEnv, VERSION } from './config.js';
import {
    clearListenerRuntime,
    clearStaleListenerRuntime,
    LISTENER_LOG_FILE,
    LISTENER_PID_FILE,
    rotateListenerLogIfLarge,
    runningListenerPid,
    spawnListenerDetached,
    stopListener,
    writeListenerRuntime,
} from './listener-process.js';
import { projectHash, remoteDigest, remoteMarkerPath, stateDir } from './gate.js';
import {
    forgetSession,
    knownSessions,
    recallSession,
    rememberSessions,
    sessionDirectoryExists,
} from './session-registry.js';
import { matchAgentByPaneCommand, REMOTE_AGENTS, type AgentKind, type RegisteredRemoteAgent } from './remote-agents.js';
import {
    installService,
    restartService,
    SERVICE_LABEL,
    serviceInstalled,
    serviceStatus,
    stopService,
    uninstallService,
} from './listener-service.js';
import { advanceState, evaluateState, findPatternMatch, type AgentState, type EvaluationResult, type StateTracker } from './agent-state.js';
import { startInventoryOffload, type InventoryOffload } from './inventory-offload.js';
import { getActiveManifest, loadManifestFromCache, refreshManifest, RULES_REFRESH_INTERVAL_MS } from './agent-rules-fetch.js';
import { decryptEphemeral, encryptEphemeral, getDevicePublicKey, initDeviceCrypto, type EncryptedEphemeralPayload } from './crypto.js';
import { createInputSequencer, type InputSequencer, type SequencedInput } from './input-sequencer.js';
import { startKeepAwake } from './keep-awake.js';

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.15;

// Hard ceiling on WebSocket connection open time. `ws` has no default
// timeout; without this an unreachable backend (NAT drop, suspended
// laptop network) can hang forever in CONNECTING state and the listener
// quietly stops reporting.
const WS_CONNECT_TIMEOUT_MS = 20_000;

// If no successful round-trip (server-persisted ack) is observed within
// this window, the socket is presumed half-open — TCP says alive but the
// peer never replies. macOS App Nap / Wi-Fi handoff / VPN flap all
// surface this way. Force-terminate so the reconnect loop runs.
const WS_STALL_TIMEOUT_MS = 90_000;

// How often the listener POLLS its local tmux session inventory (and
// immediately on $connect). Cheap — tmux runs locally, so a change is
// still detected (and sent) within a few seconds.
const SESSION_REPORT_INTERVAL_MS = 5_000;

// How often an UNCHANGED inventory is re-sent. Every send costs the
// backend a Lambda invocation + several DynamoDB reads + a WS round
// trip, and an idle listener's reports are ~95% no-ops — the dominant
// per-user variable cost. A changed inventory still goes out on the
// next 5 s poll (no latency loss); this only throttles the no-ops.
// Kept above the server's 20 s write-through window
// (AGENT_SESSIONS_REFRESH_MS) so each heartbeat also refreshes
// agentSessionsUpdatedAt. Side effect: the ack (which carries pattern
// watches) arrives at this cadence while idle, so a newly-created
// watch can take up to 30 s to reach an idle listener.
export const SESSION_REPORT_HEARTBEAT_MS = 30_000;

interface AgentSession {
    name: string;
    attached: boolean;
    agentKind: AgentKind;
    agentSessionId?: string | null;
    project: string;
    label?: string | null;
    /**
     * The name the agent itself calls this session by, when its registry
     * exposes one (Claude Code's `zeph-to-95`). A live read, not user intent —
     * the phone's rename still wins over it. Null where the agent has no name
     * concept, where the pane's session could not be identified, or where the
     * name is blank.
     *
     * Deliberately NOT `sessionName`: everywhere else in this file and on the
     * wire that word means the tmux session name (`agentSessionName` in a
     * push, `AgentWatchRecord.sessionName` on the server). Two names for a
     * session is already the problem this field exists to solve; reusing the
     * word for both would put the ambiguity in the type.
     */
    providerSessionName?: string | null;
    createdAt?: string;
    lastActivityAt?: string;
    /**
     * Detected agent state (wire contract — flows to the server and the
     * phone's Agents tab). Absent when the pane can't be captured or
     * detection is unavailable. `done` never appears here: it's derived
     * client-side (SPEC-AGENT-AWARENESS §S1/§S6).
     */
    state?: AgentState;
    stateChangedAt?: string;
    stateRuleId?: string;
}

/**
 * Change-fingerprint for the report gate. Mirrors the server's
 * REPORTED_SESSION_FIELDS comparison (zeph ws.ts sameReportedSessions):
 * same fields, order-independent, undefined/null collapsed — so the
 * client-side skip can never suppress a report the server would have
 * treated as a change. Keep the field list in sync with the server.
 */
/**
 * Sessions this machine has run and is not running now, as the phone's "past
 * sessions" list.
 *
 * The list used to be derived on the phone from a page of recent pushes, which
 * answered a different question than the one being asked: not "which sessions
 * existed on this machine" but "what is in the newest fifty pushes". A busy day
 * pushed real sessions out of that window while sessions the daemon had never
 * recorded stayed in it — so the list and the resume button disagreed in both
 * directions, offering rows that could not start and hiding rows that could.
 *
 * The registry is the machine's own answer to that question, and the same
 * record resume reads, so a row that appears here is a row that can start.
 *
 * `cwd` is deliberately left behind. The registry keeps it because resume needs
 * somewhere to start the agent; nothing off this machine needs a filesystem
 * path, and sending one would hand the relay a map of the user's disk for no
 * behaviour in return.
 *
 * Live sessions are excluded, which the phone would do anyway — but doing it
 * here also keeps the payload still. Their `lastSeenAt` moves every sweep, and
 * a field that changes every five seconds would defeat the report's
 * unchanged-inventory gate and write to the device record all day.
 */
export const KNOWN_SESSIONS_REPORTED = 30;

export interface ReportedKnownSession {
    name: string;
    agentKind: string;
    project?: string;
    label?: string;
    lastSeenAt: string;
}

export const knownSessionsToReport = (
    live: readonly AgentSession[],
    now: number = Date.now(),
): ReportedKnownSession[] => {
    const running = new Set(live.map((s) => s.name));
    return knownSessions(now)
        .filter((e) => !running.has(e.name))
        .slice(0, KNOWN_SESSIONS_REPORTED)
        .map((e) => ({
            name: e.name,
            agentKind: e.agentKind,
            ...(e.project ? { project: e.project } : {}),
            ...(e.label ? { label: e.label } : {}),
            lastSeenAt: e.lastSeenAt,
        }));
};

export const knownSessionsFingerprint = (known: ReportedKnownSession[]): string =>
    known.map((k) => `${k.name} ${k.lastSeenAt}`).sort().join('|');

export const sessionsFingerprint = (sessions: AgentSession[]): string =>
    sessions
        .map((s) => JSON.stringify([
            s.name, s.attached, s.agentKind, s.agentSessionId ?? null,
            s.project, s.label ?? null, s.providerSessionName ?? null, s.createdAt ?? null,
            s.lastActivityAt ?? null, s.state ?? null,
            s.stateChangedAt ?? null, s.stateRuleId ?? null,
        ]))
        .sort()
        .join('|');

/** True when this cycle's inventory must be sent: it changed, or the
 *  idle heartbeat is due. */
export const sessionsReportDue = (
    fingerprint: string,
    lastSentFingerprint: string | null,
    lastSentAtMs: number,
    nowMs: number,
): boolean =>
    fingerprint !== lastSentFingerprint ||
    nowMs - lastSentAtMs >= SESSION_REPORT_HEARTBEAT_MS;

// Per-session token bucket — caps a runaway/compromised sender.
//
// Weighted rather than flat, because the two things that pass through it are
// not the same size. A command submit is one whole instruction to the agent;
// 30 a minute has always been the ceiling for that, and it stays exactly that
// (120 / SUBMIT_COST). A named key is a keystroke — arrowing through a menu or
// holding Backspace is ordinary human speed, and charging it as if it were an
// instruction made the phone's key row refuse a normal burst of taps after a
// couple of seconds.
const RATE_LIMIT_TOKENS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** What one command submit costs, keeping its ceiling at the old 30/min. */
const SUBMIT_COST = 4;

// Shells are refused: a shell prompt + send-keys = arbitrary command exec.
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh']);

// Auth-failure close codes: retrying with the same bad credentials hammers
// the server forever, so the listener exits instead.
export const AUTH_FAILURE_CODES: ReadonlySet<number> = new Set([4001, 4002, 4003]);

const buckets = new Map<string, { tokens: number; lastRefillAt: number }>();

// Evict idle buckets older than this so the Map can't grow without bound
// under attack. Two refill windows past full refill = bucket is at cap
// anyway and recreating it on next hit is free.
const BUCKET_IDLE_TTL_MS = RATE_LIMIT_WINDOW_MS * 2;

const pruneStaleBuckets = (now: number): void => {
    for (const [key, b] of buckets) {
        if (now - b.lastRefillAt > BUCKET_IDLE_TTL_MS) buckets.delete(key);
    }
};

export const checkRateLimit = (
    session: string,
    now: number = Date.now(),
    cost: number = 1,
): boolean => {
    pruneStaleBuckets(now);
    const b = buckets.get(session) ?? { tokens: RATE_LIMIT_TOKENS, lastRefillAt: now };
    const elapsed = Math.max(0, now - b.lastRefillAt);
    // Fractional refill is intentional: smooths the boundary so a session
    // hitting the cap doesn't have to wait a full window for the next slot.
    const refilled = Math.min(
        RATE_LIMIT_TOKENS,
        b.tokens + (elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_TOKENS,
    );
    if (refilled < cost) {
        buckets.set(session, { tokens: refilled, lastRefillAt: now });
        return false;
    }
    buckets.set(session, { tokens: refilled - cost, lastRefillAt: now });
    return true;
};

/** Read the foreground command in the named tmux session's active pane. */
export const paneCurrentCommand = (session: string): string | null => {
    const result = spawnSync('tmux', tmuxArgs(['display-message', '-p', '-t', session, '#{pane_current_command}']), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    return (result.stdout ?? '').trim() || null;
};

const isShellPane = (command: string | null): boolean => {
    if (!command) return false;
    return SHELL_COMMANDS.has(command);
};

/** Where a message is parked between `set-buffer` and `paste-buffer`. Named,
 *  so the user's own paste stack is never pushed onto, and `-d` drops it
 *  again the moment it has been delivered. */
const INJECT_BUFFER = 'zeph-inject';

const sendLiteral = (session: string, text: string): boolean =>
    spawnSync('tmux', tmuxArgs(['send-keys', '-l', '-t', session, text]), { stdio: ['ignore', 'ignore', 'pipe'] })
        .status === 0;

/**
 * Put the message in the pane as a PASTE rather than as typing.
 *
 * `send-keys -l` hands the whole string to the application as if it had been
 * typed at once, and a TUI that re-renders per character has to keep up with a
 * burst it never sees from a human. With Hangul — three bytes and two columns
 * per character — it does not: characters go missing and the wrapped line is
 * painted twice. A phone message is a paste, so send it as one.
 *
 * `paste-buffer -p` brackets it only when the application has actually asked
 * for bracketed paste (DECSET 2004); against one that has not, tmux sends the
 * plain text and nothing changes. That gating is why this is safe to do
 * unconditionally — the markers can never leak into an app that would show
 * them as literal `[200~`.
 *
 * Falls back to the old path if either tmux call fails, because a message
 * delivered imperfectly still beats one not delivered.
 */
const pasteText = (session: string, text: string): boolean => {
    // `--` so a message that begins with a dash is data, not an option. The
    // buffer contents are data to paste-buffer as well, which preserves the
    // property `send-keys -l` had: no escape sequence inside a message can
    // drive another tmux command.
    const set = spawnSync('tmux', tmuxArgs(['set-buffer', '-b', INJECT_BUFFER, '--', text]), { stdio: ['ignore', 'ignore', 'pipe'] });
    if (set.status !== 0) return sendLiteral(session, text);
    const paste = spawnSync('tmux', tmuxArgs(['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', session]), { stdio: ['ignore', 'ignore', 'pipe'] });
    if (paste.status === 0) return true;
    // `-d` never ran, so the buffer is still there holding the message.
    spawnSync('tmux', tmuxArgs(['delete-buffer', '-b', INJECT_BUFFER]), { stdio: ['ignore', 'ignore', 'pipe'] });
    return sendLiteral(session, text);
};

/**
 * Inject text into a tmux session: the message as a paste, then a separate
 * `Enter` to submit it. The two stay separate because a bracketed paste is
 * text and only text — newlines inside it must not submit early, and the
 * submit has to be a real key press.
 *
 * Delivering text WITHOUT the submit is `pasteText` on its own — see the
 * `insert` wire field and tryInject's `submit` parameter.
 */
const injectKeys = (session: string, text: string): boolean => {
    if (!pasteText(session, text)) return false;
    const b = spawnSync('tmux', tmuxArgs(['send-keys', '-t', session, 'Enter']), { stdio: ['ignore', 'ignore', 'pipe'] });
    return b.status === 0;
};

// Named keys the phone may inject to drive a full-screen Claude Code pane
// (a `/usage` modal captures text input — only a real Escape/arrow gets out).
// Maps a lowercase wire name to the exact tmux key token. Whitelist-ONLY:
// anything outside this map is refused so a compromised sender can't smuggle
// `C-c`, `M-x`, or a shell command through send-keys' key-name syntax.
// A Map, not a plain object: object indexing leaks the prototype chain, so
// `keys: ['constructor']` resolved to a function that spawnSync happily
// stringified into the pane. Map lookups know only what was put in.
const ALLOWED_KEYS = new Map<string, string>([
    ['escape', 'Escape'],
    ['up', 'Up'],
    ['down', 'Down'],
    ['left', 'Left'],
    ['right', 'Right'],
    ['enter', 'Enter'],
    ['tab', 'Tab'],
    ['backtab', 'BTab'],
    ['backspace', 'BSpace'],
    ['delete', 'DC'],
    ['space', 'Space'],
    // Control keys, added one at a time and only where the phone has no other
    // way to do the thing: interrupt what the agent is doing, toggle its
    // verbose output, clear the screen. The whitelist property is unchanged —
    // naming three does not open send-keys' key-name syntax to a fourth.
    //
    // `ctrl-d` is deliberately absent. At an empty prompt it is EOF: the agent
    // exits, the pane falls back to a shell, and isShellPane then refuses
    // everything — correctly, but the phone has no way to start it again.
    ['ctrl-c', 'C-c'],
    ['ctrl-r', 'C-r'],
    ['ctrl-l', 'C-l'],
]);

/**
 * Translate a phone-supplied key list to tmux tokens. Returns null if ANY
 * key is unknown — a partial injection (some keys land, one is dropped)
 * leaves the pane in a worse mid-state than none, so the whole batch is
 * rejected.
 */
export const resolveKeys = (keys: string[]): string[] | null => {
    const out: string[] = [];
    for (const k of keys) {
        const token = ALLOWED_KEYS.get(k.toLowerCase().trim());
        if (!token) return null;
        out.push(token);
    }
    return out.length ? out : null;
};

/**
 * Send named keys as keys (NOT `-l`), so tmux interprets Escape/Up/Enter as
 * key presses rather than literal text. One send-keys call carries the
 * whole sequence in order.
 */
const injectNamedKeys = (session: string, tokens: string[]): boolean => {
    const r = spawnSync('tmux', tmuxArgs(['send-keys', '-t', session, ...tokens]), { stdio: ['ignore', 'ignore', 'pipe'] });
    return r.status === 0;
};

const stamp = (): string => new Date().toISOString().slice(11, 19);
const log = (msg: string): void => console.log(`[${stamp()}] ${msg}`);

// ─── tmux socket discovery ──────────────────────────────────────────

/**
 * macOS sets a per-user `TMPDIR` like `/var/folders/xz/.../T/`, and tmux
 * (started from a regular shell there) lays its socket at
 * `<TMPDIR>/tmux-<uid>/default`. When the listener is spawned from a
 * shell with a different TMPDIR — or no TMPDIR at all (cron, launchd,
 * IDE-managed terminals) — tmux defaults to `/tmp/tmux-<uid>/default`
 * and the user's real server is invisible. We probe a small list of
 * common locations and use `-S <path>` for every subsequent tmux call
 * once a live server is found.
 *
 * Caching is one-way: a successful discovery sticks for the process
 * lifetime, but failure does NOT — we re-probe every cycle so the
 * listener picks up a tmux server that gets started AFTER the listener
 * itself (very common: the user opens `zeph cc` after starting the
 * daemon). If tmux dies and respawns under a different path the user
 * has to restart the listener (rare).
 */
let cachedSocketPath: string | null = null;
/** True once we've confirmed a working socket. `cachedSocketPath` of
 *  `null` is ambiguous on its own — it can mean either "use default
 *  (we verified it works)" or "we haven't checked yet". This flag
 *  removes the ambiguity so we don't re-probe every collectSessions
 *  cycle (which was spamming the log with "tmux: default socket OK"). */
let cacheValid = false;

/**
 * Mark the cached socket as no longer trustworthy — call this when a
 * tmux command fails against the cached path. The next findTmuxSocket()
 * will redo full discovery (default probe → /var/folders walk → lsof
 * fallback) instead of returning a stale answer. Without this the
 * listener wedged at "reported 0 session(s)" forever after a tmux
 * server restart, even when a new server was live and discoverable.
 */
export const invalidateTmuxSocketCache = (): void => {
    cacheValid = false;
    cachedSocketPath = null;
};

interface ProbeResult {
    ok: boolean;
    stderr?: string;
}

const probeTmuxSocketDetail = (socketPath: string | null): ProbeResult => {
    const args = socketPath ? ['-S', socketPath, 'list-sessions'] : ['list-sessions'];
    const r = spawnSync('tmux', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) return { ok: true };
    const err = ((r.stderr ?? '') as string).trim();
    return { ok: false, stderr: err || undefined };
};

const probeTmuxSocket = (socketPath: string | null): boolean =>
    probeTmuxSocketDetail(socketPath).ok;

/**
 * List every socket file inside a `tmux-<uid>/` directory. tmux's
 * default socket name is `default`, but users can change it with
 * `tmux -L <name>` or via .tmux.conf — so we probe every file we find,
 * not just `default`. Returns absolute socket paths.
 */
const listSocketsIn = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    try { return readdirSync(dir).map((name) => `${dir}/${name}`); }
    catch { return []; }
};

/**
 * Final-fallback socket discovery: find tmux server processes via `ps`
 * and ask `lsof` what unix socket each is bound to. Handles the cases
 * filesystem walking can't:
 *   - macOS auto-cleanup deleted the socket file while the server kept
 *     running (the most likely cause of "no server running" errors when
 *     a tmux session is clearly alive in another iTerm/Warp pane)
 *   - The user runs tmux with `-L <name>` or `-S <unusual-path>` that we
 *     never thought to enumerate
 *
 * `lsof` on macOS may report sockets as `(deleted)`. Even then, if the
 * server still has the inode open we can still tmux-attach by recreating
 * the path — but for now we only return paths that still exist on disk
 * so tmux's connect logic isn't confused. If the path is gone, the user
 * has to `tmux kill-server` + restart anyway.
 */
const findTmuxViaProcess = (): string[] => {
    const username = userInfo().username;
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,user=,command='], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (ps.status !== 0) return [];

    const tmuxPids: string[] = [];
    for (const line of (ps.stdout ?? '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const [, pid, user, cmd] = m;
        if (user !== username) continue;
        // Server processes show up as `tmux: server` (with the colon) on
        // some versions; client/wrapper invocations show up as `tmux new`
        // / `tmux attach` etc. lsof works on either.
        if (!/(^|[^\w-])tmux($|[:\s])/.test(cmd)) continue;
        tmuxPids.push(pid);
    }
    if (tmuxPids.length === 0) return [];

    const found = new Set<string>();
    for (const pid of tmuxPids) {
        const lsof = spawnSync('lsof', ['-p', pid, '-Fn'], {
            encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (lsof.status !== 0) continue;
        // `-Fn` prints names prefixed with `n`; one per line. Filter for
        // tmux-shaped socket paths.
        for (const lline of (lsof.stdout ?? '').split('\n')) {
            if (!lline.startsWith('n')) continue;
            const path = lline.slice(1);
            if (!/\/tmux-\d+\//.test(path)) continue;
            if (path.endsWith(' (deleted)') || path.includes('(deleted)')) continue;
            if (existsSync(path)) found.add(path);
        }
    }
    return [...found];
};

/** Walk `/var/folders` for user-owned `tmux-<uid>/*` socket files. Each
 * subdir is wrapped in its own try/catch — entries that belong to other
 * users (or that we otherwise can't read) must skip cleanly, not abort
 * the whole walk. */
const walkVarFolders = (uid: number): string[] => {
    const found: string[] = [];
    const root = '/var/folders';
    if (!existsSync(root)) return found;
    let topEntries: string[];
    try { topEntries = readdirSync(root); } catch { return found; }
    for (const a of topEntries) {
        const aPath = `${root}/${a}`;
        let subEntries: string[];
        try { subEntries = readdirSync(aPath); } catch { continue; }
        for (const b of subEntries) {
            found.push(...listSocketsIn(`${aPath}/${b}/T/tmux-${uid}`));
        }
    }
    return found;
};

/**
 * Track whether the "no server anywhere" diagnostic was already logged
 * this run. We want the user to see the path list *once* on first
 * failure, then go quiet until we either find a server or notice a new
 * candidate file appearing — otherwise every 30-s cycle would spam the
 * full probe report.
 */
let warnedNoServer = false;

const findTmuxSocket = (): string | null => {
    // Successful discovery sticks. Failure does NOT — we want to pick
    // up a tmux server that the user launches *after* `zeph listener`.
    if (cacheValid) return cachedSocketPath;

    // Explicit override — for users with `tmux -L <name>` setups or
    // unusual socket locations. Skip discovery entirely if set and
    // probeable.
    const override = process.env.ZEPH_TMUX_SOCKET;
    if (override) {
        if (probeTmuxSocket(override)) {
            cachedSocketPath = override;
            cacheValid = true;
            log(`tmux socket → ${override} (from ZEPH_TMUX_SOCKET)`);
            warnedNoServer = false;
            return override;
        }
        // Fall through to standard discovery if override fails — better
        // than failing silently. We re-log this every cycle (no
        // `warnedNoServer`) because it's a user-supplied setting we want
        // to keep nagging about.
        log(`tmux: ZEPH_TMUX_SOCKET=${override} probe failed, falling back to auto-discovery`);
    }

    const uid = userInfo().uid;
    const candidates: string[] = [];

    // Process-based discovery first — it's the only path that handles
    // stale-socket-file cases (macOS /tmp cleanup) and unusual socket
    // locations the heuristic walks would miss.
    candidates.push(...findTmuxViaProcess());

    // Include every socket file we find in any `tmux-<uid>/` dir — the
    // user might have `-L <name>` configured rather than the default
    // socket name.
    const envDir = process.env.TMUX_TMPDIR || process.env.TMPDIR;
    if (envDir) candidates.push(...listSocketsIn(`${envDir.replace(/\/+$/, '')}/tmux-${uid}`));
    candidates.push(...walkVarFolders(uid));
    candidates.push(...listSocketsIn(`/tmp/tmux-${uid}`));
    candidates.push(...listSocketsIn(`/private/tmp/tmux-${uid}`));

    const seen = new Set<string>();
    const unique = candidates.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

    // Default first — succeeds when the shell that launched us shares
    // tmux's view. We deliberately don't cache this success; on the
    // first call though it's enough.
    if (probeTmuxSocket(null)) {
        cachedSocketPath = null; // null means "use default"
        cacheValid = true;
        if (!warnedNoServer) log('tmux: default socket OK');
        warnedNoServer = false;
        return null;
    }

    for (const path of unique) {
        if (!existsSync(path)) continue;
        if (probeTmuxSocket(path)) {
            cachedSocketPath = path;
            cacheValid = true;
            log(`tmux socket → ${path}`);
            warnedNoServer = false;
            return path;
        }
    }

    // No live tmux yet. Log the full probe report once, then stay quiet
    // until something works — otherwise the user gets a 4-line dump
    // every 30 seconds while they're still bringing tmux up. Include the
    // tmux binary identification + stderr for failed probes so the user
    // can spot version mismatches (homebrew on /usr/local vs /opt/homebrew)
    // or stale socket files.
    if (!warnedNoServer) {
        const which = spawnSync('which', ['tmux'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tmuxPath = (which.stdout ?? '').trim() || '(not on PATH)';
        const ver = spawnSync('tmux', ['-V'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tmuxVer = (ver.stdout ?? '').trim() || '?';
        log(`tmux: no live server yet — using ${tmuxPath} (${tmuxVer})`);
        log(`tmux: probed ${unique.length} candidate(s):`);
        for (const path of unique) {
            if (!existsSync(path)) {
                log(`  - ${path}  (no socket file)`);
                continue;
            }
            const detail = probeTmuxSocketDetail(path);
            log(`  ✗ ${path}  (${detail.stderr ?? 'probe failed without stderr'})`);
        }
        log(`tmux: will retry each cycle. If your tmux uses a custom socket,`);
        log(`     run \`tmux info | head -1\` in the same shell as 'zeph cc'`);
        log(`     and pass it via:  ZEPH_TMUX_SOCKET=<path> zeph listener`);
        warnedNoServer = true;
    }
    return null;
};

/** Prepend `-S <socket>` when we've discovered a non-default tmux server. */
const tmuxArgs = (args: string[]): string[] => {
    const sock = findTmuxSocket();
    return sock ? ['-S', sock, ...args] : args;
};

// ─── Session inventory ──────────────────────────────────────────────

/**
 * Parse a `zeph-*` tmux session name into `{project, label}`. For
 * Phase 1 the wrapper only emits `zeph-<project>` (no labels), so the
 * whole tail becomes the project. When labels land in Phase 2 the
 * wrapper will sidecar `{project, label}` so the listener doesn't need
 * to guess from a name that allows dashes in project names.
 */
export const parseSessionName = (name: string): { project: string; label: string | null } | null => {
    if (!name.startsWith('zeph-')) return null;
    const rest = name.slice('zeph-'.length);
    if (!rest) return null;
    return { project: rest, label: null };
};

interface PaneInfo {
    currentCommand: string | null;
    startCommand: string | null;
    currentPath: string | null;
    panePid: number | null;
}

// U+241F "Symbol for Unit Separator" — a *printable* Unicode glyph
// (3-byte UTF-8) that visually represents the C0 Unit Separator but is
// itself a normal character. Critical detail: tmux 3.5a's `-F` format
// escapes raw control bytes (0x00-0x1F) like `\037` for terminal safety,
// which broke an earlier `'\x1f'` separator — the byte we passed never
// arrived at the consumer end. A printable Unicode char passes through
// verbatim and won't appear in any real session name or filesystem path.
const FIELD_SEP = '␟';

const readPaneInfo = (session: string): PaneInfo => {
    const r = spawnSync('tmux', tmuxArgs(['display-message', '-p', '-t', session,
        `#{pane_current_command}${FIELD_SEP}#{pane_start_command}${FIELD_SEP}#{pane_current_path}${FIELD_SEP}#{pane_pid}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0) return { currentCommand: null, startCommand: null, currentPath: null, panePid: null };
    const parts = (r.stdout ?? '').trim().split(FIELD_SEP);
    if (parts.length !== 4) return { currentCommand: null, startCommand: null, currentPath: null, panePid: null };
    const [current, start, path, pid] = parts;
    const parsedPid = Number(pid);
    return {
        currentCommand: current || null,
        startCommand: start || null,
        currentPath: path || null,
        panePid: Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null,
    };
};

/**
 * Strip the surrounding quotes tmux uses when serialising commands
 * with spaces. `tmux display-message -p '#{pane_start_command}'`
 * outputs `"claude --resume xxx"` (literal double-quotes around the
 * whole shell-command form the wrapper passed). Without unwrapping,
 * the leading `"` made the basename check fail and the listener
 * skipped the session as 'no agent in pane'.
 */
const unwrapQuotes = (cmd: string): string => {
    const m = cmd.match(/^"(.+)"$/) || cmd.match(/^'(.+)'$/);
    return m ? m[1] : cmd;
};

const firstTokenBasename = (cmd: string | null): string => {
    if (!cmd) return '';
    const stripped = unwrapQuotes(cmd.trim());
    return basename(stripped.split(/\s+/)[0] || '');
};

/**
 * Identify the agent from the tmux pane. Prefer `pane_start_command`
 * because the foreground process is usually `node`/`python3` (the
 * interpreter), which doesn't tell us *what* was launched. Fall back to
 * `pane_current_command` when start_command is empty — tmux clears
 * start_command in some re-attach cases, especially when a pre-existing
 * session was joined via `tmux new -A` instead of being created fresh.
 * That fallback is safe because only the literal binaries registered in
 * remote-agents.ts are accepted as a match.
 */
export const detectRemoteAgent = (info: PaneInfo): RegisteredRemoteAgent | null =>
    matchAgentByPaneCommand(firstTokenBasename(info.startCommand))
    ?? matchAgentByPaneCommand(firstTokenBasename(info.currentCommand))
    ?? null;

const epochToIso = (epoch: string | undefined): string | undefined => {
    if (!epoch) return undefined;
    const n = Number(epoch);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return new Date(n * 1000).toISOString();
};

// ─── Agent state detection (SPEC-AGENT-AWARENESS §S1) ──────────────

// How many pane lines the state rules see. The live status area every
// agent renders sits in the last handful of lines; 40 leaves margin for
// tall dialogs without hauling whole scrollbacks through regex.
const STATE_CAPTURE_LINES = 40;

interface SessionStateEntry {
    tracker: StateTracker;
    /** Last raw evaluation — replayed on hash-equal cycles so a pending
     *  candidate still collects its second sighting on a static screen. */
    lastObserved: EvaluationResult;
    contentHash: string;
}

const sessionStates = new Map<string, SessionStateEntry>();

/** Test hook. */
export const resetSessionStates = (): void => {
    sessionStates.clear();
};

const capturePaneText = (session: string): string | null => {
    const r = spawnSync('tmux', tmuxArgs(['capture-pane', '-p', '-t', session, '-S', `-${STATE_CAPTURE_LINES}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    return r.stdout ?? '';
};

/**
 * Fold one pane capture into the per-session state machine and return
 * the wire fields for this report cycle. Exported (with `paneText`
 * injected) so tests can drive it without tmux.
 *
 * Hash short-circuit: an unchanged screen skips rule evaluation but
 * still replays the previous observation through the debounce — cheap
 * cycles stay cheap without wedging candidate promotion.
 */
export const deriveSessionState = (
    name: string,
    agentKind: AgentKind,
    paneText: string | null,
    now: number = Date.now(),
): Pick<AgentSession, 'state' | 'stateChangedAt' | 'stateRuleId'> => {
    if (paneText === null) {
        // Pane unreadable this cycle (session racing shutdown, tmux
        // hiccup) — report nothing rather than a stale confident state.
        sessionStates.delete(name);
        return {};
    }
    const contentHash = createHash('sha1').update(paneText).digest('hex');
    const entry = sessionStates.get(name);
    const observed = entry && entry.contentHash === contentHash
        ? entry.lastObserved
        : evaluateState(paneText, agentKind, getActiveManifest(), entry?.tracker.confirmed ?? 'unknown');
    const tracker = advanceState(entry?.tracker, observed, now);
    sessionStates.set(name, { tracker, lastObserved: observed, contentHash });
    return {
        state: tracker.confirmed,
        stateChangedAt: new Date(tracker.confirmedAt).toISOString(),
        stateRuleId: tracker.ruleId,
    };
};

/** Drop trackers for sessions gone from the inventory. */
const pruneSessionStates = (liveNames: Set<string>): void => {
    for (const name of sessionStates.keys()) {
        if (!liveNames.has(name)) sessionStates.delete(name);
    }
};

// ─── Pattern watches (SPEC-AGENT-AWARENESS §S5 v2) ─────────────────

export interface PatternWatch {
    sessionName: string;
    pattern: string;
}

let patternWatches: PatternWatch[] = [];
// One-shot: after a hit we stop re-evaluating that watch locally. The
// server deletes the record on hit, and the next ack prunes it here —
// the fired-set only bridges the gap between hit and ack.
const firedWatchKeys = new Set<string>();
const patternWatchKey = (w: PatternWatch): string => `${w.sessionName}${w.pattern}`;

/** Ack payload → active watch list. Prunes fired-markers for dead watches. */
export const setPatternWatches = (raw: unknown): void => {
    patternWatches = Array.isArray(raw)
        ? raw.filter((w): w is PatternWatch =>
            typeof w === 'object' && w !== null
            && typeof (w as PatternWatch).sessionName === 'string'
            && typeof (w as PatternWatch).pattern === 'string')
        : [];
    const live = new Set(patternWatches.map(patternWatchKey));
    for (const key of firedWatchKeys) {
        if (!live.has(key)) firedWatchKeys.delete(key);
    }
};

/** Test hook. */
export const resetPatternWatches = (): void => {
    patternWatches = [];
    firedWatchKeys.clear();
};

export interface WatchHit {
    sessionName: string;
    pattern: string;
    matchedLine: string;
}

/**
 * Probe every un-fired watch whose session is live. `capture` is
 * injectable for tests; production passes capturePaneText.
 */
export const collectWatchHits = (
    liveNames: ReadonlySet<string>,
    capture: (session: string) => string | null = capturePaneText,
): WatchHit[] => {
    const hits: WatchHit[] = [];
    const textCache = new Map<string, string | null>();
    for (const w of patternWatches) {
        if (!liveNames.has(w.sessionName)) continue;
        const key = patternWatchKey(w);
        if (firedWatchKeys.has(key)) continue;
        if (!textCache.has(w.sessionName)) textCache.set(w.sessionName, capture(w.sessionName));
        const text = textCache.get(w.sessionName);
        if (text === null || text === undefined) continue;
        const match = findPatternMatch(w.pattern, text);
        if (!match) continue;
        firedWatchKeys.add(key);
        hits.push({ sessionName: w.sessionName, pattern: w.pattern, matchedLine: match.line });
    }
    return hits;
};

// ─── Screen peek (SPEC-AGENT-AWARENESS §S4) ────────────────────────

// Pane lines returned to the phone. Taller than the state-detection
// capture — the user wants to READ this, not regex it.
const SCREEN_PEEK_LINES = 60;
// Ephemeral frames ride API Gateway WS (32KB frame limit); stay well
// under it after JSON envelope overhead.
const SCREEN_PEEK_MAX_BYTES = 24 * 1024;

export interface ScreenRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
}

export interface ScreenSnapshot {
    subtype: 'agent.screen.snapshot';
    requestId: string;
    sessionName: string;
    content?: string;
    truncated?: boolean;
    error?: string;
    capturedAt: string;
}

/**
 * Answer a phone's screen-peek request for one of OUR sessions.
 * Returns null when the message isn't addressed to this machine (other
 * ephemeral traffic — clipboard, mirrors — flows through constantly).
 *
 * Security posture: only sessions the inventory already exposes are
 * readable — the phone can see exactly the panes it can already send
 * commands into, nothing else. Rate-limited with the same per-session
 * token bucket as command injection.
 */
export const handleScreenRequest = (req: ScreenRequest): ScreenSnapshot | null => {
    if (req.subtype !== 'agent.screen.request') return null;
    if (!req.requestId || !req.sessionName) return null;
    if (req.targetDeviceId !== computeListenerDeviceId()) return null;

    const capturedAt = new Date().toISOString();
    const base = { subtype: 'agent.screen.snapshot' as const, requestId: req.requestId, sessionName: req.sessionName, capturedAt };

    if (!checkRateLimit(`screen:${req.sessionName}`)) {
        return { ...base, error: 'rate_limited' };
    }
    if (!isInventoried(req.sessionName)) {
        return { ...base, error: 'unknown_session' };
    }
    const captured = capturePane(req.sessionName);
    if (!captured) {
        return { ...base, error: 'capture_failed' };
    }
    return { ...base, ...captured };
};

// ─── Diff: reading a session's changes from the phone ──────────────
//
// The loop the phone could not close: it can drive an agent but not look at
// what the agent did. This reads the working tree of the repository the session
// runs in — read-only, fixed commands, no revision and no repository path from
// the wire.
//
// Why nothing caller-supplied reaches argv: `git diff <ref>` parses a ref
// beginning with `-` as a flag, so a "validate the string" defence has to be
// perfect to work at all. Instead the commands are constant, the repo comes
// from the registry this machine wrote itself, and the one caller-supplied
// value — a file path — is resolved against the repo root, checked through
// symlinks, and passed after `--` where git can only read it as a path.

/** Ceiling on one page of patch text. Shares the frame budget the pane
 *  snapshots use: a diff is routinely megabytes, so paging is in the contract
 *  from the start rather than bolted on later. */
export const DIFF_PAGE_MAX_BYTES = 16 * 1024;
/** Most changed files worth listing. A tree past this is not something anyone
 *  reviews on a phone; the count says so instead of the list pretending. */
const DIFF_MAX_FILES = 200;

export interface DiffFilesRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
    /** Seals the answer for this key when present, exactly as a stream frame is
     *  sealed for its subscriber. Absent = the caller has no device key. */
    subscriberPublicKey?: string;
}

export interface DiffFileRequest extends DiffFilesRequest {
    /** Repo-relative path of the file to read. The only caller-supplied value
     *  that reaches git, and only after the checks in resolveInRepo. */
    path?: string;
    /** Byte offset into this file's patch — paging, since one patch can dwarf
     *  the frame limit on its own. */
    offset?: number;
}

export interface DiffFileEntry {
    path: string;
    /** Porcelain status letter: M, A, D, R, ? for untracked. */
    status: string;
    added: number;
    removed: number;
}

const gitIn = (repo: string, args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync('git', ['-C', repo, '--no-optional-locks', ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** The repository the session's directory belongs to, or null when it is not
 *  in one. Asked of git rather than guessed from the path. */
const repoRootFor = (cwd: string): string | null => {
    const r = gitIn(cwd, ['rev-parse', '--show-toplevel']);
    const root = r.stdout.trim();
    return r.status === 0 && root ? root : null;
};

/**
 * A repo-relative path resolved to somewhere genuinely inside the repo, or null.
 *
 * Checks the real path, not the lexical one: `resolve()` alone accepts a
 * symlink whose string stays inside the repo and whose target does not, which
 * is the whole trick. An unresolvable path (the file was deleted) falls back to
 * the lexical check — a deleted file still has a diff worth reading.
 */
const resolveInRepo = (root: string, rel: string): string | null => {
    if (isAbsolute(rel)) return null;
    const lexical = resolve(root, rel);
    const inside = (p: string): boolean => p === root || p.startsWith(root + sep);
    if (!inside(lexical)) return null;
    try {
        const realRoot = realpathSync(root);
        const real = realpathSync(lexical);
        return real === realRoot || real.startsWith(realRoot + sep) ? lexical : null;
    } catch {
        return lexical;
    }
};

/** Session name → the repository it works in, with every refusal named. */
const repoForSession = (sessionName: string): { root: string } | { error: string } => {
    const known = recallSession(sessionName);
    if (!known) return { error: 'unknown_session' };
    if (!sessionDirectoryExists(known)) return { error: 'missing_directory' };
    const root = repoRootFor(known.cwd);
    if (!root) return { error: 'not_a_repo' };
    return { root };
};

/** Send a reply, sealed when the caller handed over a key. A seal that fails is
 *  an error rather than a plaintext answer — same rule as the frame path. */
const sendMaybeSealed = (
    send: (data: Record<string, unknown>) => void,
    base: Record<string, unknown>,
    payload: { field: string; value: string },
    subscriberPublicKey: string | undefined,
): true => {
    if (!subscriberPublicKey) {
        send({ ...base, [payload.field]: payload.value });
        return true;
    }
    encryptEphemeral(payload.value, subscriberPublicKey)
        .then((encrypted) => send({ ...base, encrypted }))
        .catch((err) => {
            log(`⧉ diff: seal failed (${err instanceof Error ? err.message : err})`);
            send({ ...base, error: 'encrypt_failed' });
        });
    return true;
};

/** Parse `git diff --numstat` into per-path counts. Binary files report `-`. */
const parseNumstat = (out: string): Map<string, { added: number; removed: number }> => {
    const counts = new Map<string, { added: number; removed: number }>();
    for (const line of out.split('\n')) {
        if (!line) continue;
        const [added, removed, ...rest] = line.split('\t');
        const path = rest.join('\t');
        if (!path) continue;
        counts.set(path, {
            added: Number.isInteger(Number(added)) ? Number(added) : 0,
            removed: Number.isInteger(Number(removed)) ? Number(removed) : 0,
        });
    }
    return counts;
};

/** Parse `git status --porcelain=v1` into (status letter, path) pairs. */
const parsePorcelain = (out: string): Array<{ status: string; path: string }> => {
    const rows: Array<{ status: string; path: string }> = [];
    for (const line of out.split('\n')) {
        if (line.length < 4) continue;
        const code = line.slice(0, 2).trim();
        // Renames report `old -> new`; the new path is what a reader opens.
        const raw = line.slice(3);
        const path = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
        if (!path) continue;
        rows.push({ status: code === '??' ? '?' : code[0], path });
    }
    return rows;
};

/**
 * Answer "what changed in this session's repo".
 *
 * Every argument is constant: the request contributes a session name, which
 * selects a directory from the registry, and nothing else reaches git.
 */
export const handleDiffFilesRequest = (
    req: DiffFilesRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.diff.files.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const base = {
        subtype: 'agent.diff.files.result' as const,
        requestId: req.requestId,
        sessionName: req.sessionName,
        at: new Date().toISOString(),
    };
    const reply = (fields: Record<string, unknown>): true => {
        send({ ...base, ...fields });
        return true;
    };

    if (!checkRateLimit(`diff:${req.sessionName}`)) return reply({ error: 'rate_limited' });
    const repo = repoForSession(req.sessionName);
    if ('error' in repo) return reply({ error: repo.error });

    const status = gitIn(repo.root, ['status', '--porcelain=v1']);
    if (status.status !== 0) return reply({ error: 'git_failed' });
    const counts = parseNumstat(gitIn(repo.root, ['diff', '--numstat']).stdout);

    const rows = parsePorcelain(status.stdout);
    const files: DiffFileEntry[] = rows.slice(0, DIFF_MAX_FILES).map((r) => ({
        path: r.path,
        status: r.status,
        added: counts.get(r.path)?.added ?? 0,
        removed: counts.get(r.path)?.removed ?? 0,
    }));
    // The list itself is metadata about the tree — paths, counts. The patch
    // TEXT is what gets sealed; a caller with a key gets the list sealed too,
    // since a path list is itself a fair amount to hand a relay.
    if (!req.subscriberPublicKey) {
        return reply({ files, truncated: rows.length > DIFF_MAX_FILES });
    }
    return sendMaybeSealed(
        send,
        { ...base, truncated: rows.length > DIFF_MAX_FILES },
        { field: 'files', value: JSON.stringify(files) },
        req.subscriberPublicKey,
    );
};

/**
 * Answer one file's patch, one page at a time.
 *
 * The path is the only caller-supplied value that reaches git, and it reaches
 * it as its own argv entry after `--`, having been resolved against the repo
 * root and checked through symlinks first.
 */
export const handleDiffFileRequest = (
    req: DiffFileRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.diff.file.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const base = {
        subtype: 'agent.diff.file.result' as const,
        requestId: req.requestId,
        sessionName: req.sessionName,
        path: typeof req.path === 'string' ? req.path : '',
        at: new Date().toISOString(),
    };
    const reply = (fields: Record<string, unknown>): true => {
        send({ ...base, ...fields });
        return true;
    };

    if (typeof req.path !== 'string' || !req.path) return reply({ error: 'bad_path' });
    const offset = req.offset ?? 0;
    if (!isPageOffset(offset)) return reply({ error: 'bad_range' });
    if (!checkRateLimit(`diff:${req.sessionName}`)) return reply({ error: 'rate_limited' });

    const repo = repoForSession(req.sessionName);
    if ('error' in repo) return reply({ error: repo.error });
    if (!resolveInRepo(repo.root, req.path)) {
        log(`✗ diff ${req.sessionName}: ${req.path} is outside ${repo.root}`);
        return reply({ error: 'path_outside_repo' });
    }

    const out = gitIn(repo.root, ['diff', '--no-color', '--', req.path]);
    if (out.status !== 0) return reply({ error: 'git_failed' });
    // Byte offsets, not line ones: the caller pages by what the transport can
    // carry, and a single line of minified output can exceed a page on its own.
    const buf = Buffer.from(out.stdout, 'utf-8');
    const page = buf.subarray(offset, offset + DIFF_PAGE_MAX_BYTES);
    const meta = {
        ...base,
        offset,
        length: page.length,
        hasMore: offset + page.length < buf.length,
    };
    return sendMaybeSealed(
        send,
        meta,
        { field: 'chunk', value: page.toString('utf-8') },
        req.subscriberPublicKey,
    );
};

// ─── Resume: starting a session that has ended ─────────────────────
//
// Every other remote path types into a process that already exists. This one
// creates one, which is a different kind of authority, so the request is built
// to carry as little of it as possible: a session NAME and nothing else.
// Where to start and what to start are read back from the registry this machine
// wrote while the session was alive (session-registry.ts) — a phone, or a relay
// posing as one, cannot name a directory, a binary, or an argument.

export interface SessionResumeRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
}

export interface SessionResumeResult {
    subtype: 'agent.session.resume.result';
    requestId: string;
    sessionName: string;
    resumed?: true;
    error?: string;
    at: string;
}

/**
 * Start a remembered session again, detached, and tell the phone what happened.
 * Returns true when the message was ours to answer.
 *
 * The refusals are the design. Unknown name: not in the registry, so there is
 * nothing to start and nothing to guess from. Missing directory: the project
 * moved or was deleted, and starting an agent in the wrong place is worse than
 * not starting one. Unknown agent kind: the record names an agent this build
 * has no binary for — a wire enum outlives installs, and a guess here would be
 * a command nobody chose. Already running: the session is live and the phone
 * should be watching it, not replacing it.
 */
export const handleSessionResumeRequest = (
    req: SessionResumeRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.session.resume.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const sessionName = req.sessionName;
    const base = {
        subtype: 'agent.session.resume.result' as const,
        requestId: req.requestId,
        sessionName,
        at: new Date().toISOString(),
    };
    const reply = (fields: Partial<SessionResumeResult>): true => {
        send({ ...base, ...fields });
        return true;
    };

    // Charged like a submitted command, not like a keystroke: this starts a
    // process, and the two share one budget so a flood cannot be laundered
    // through whichever path is cheaper.
    if (!checkRateLimit(sessionName, undefined, SUBMIT_COST)) return reply({ error: 'rate_limited' });

    const known = recallSession(sessionName);
    if (!known) {
        log(`✗ resume ${sessionName}: never seen on this machine`);
        return reply({ error: 'unknown_session' });
    }
    if (sessionExists(sessionName)) return reply({ error: 'already_running' });
    if (!sessionDirectoryExists(known)) {
        log(`✗ resume ${sessionName}: ${known.cwd} is gone`);
        return reply({ error: 'missing_directory' });
    }
    const agent = REMOTE_AGENTS.find((a) => a.kind === known.agentKind);
    if (!agent) {
        log(`✗ resume ${sessionName}: no binary for agent kind ${known.agentKind}`);
        return reply({ error: 'unknown_agent' });
    }

    // argv, never a shell string: the binary comes from the agent table and the
    // directory from our own record, and neither is concatenated into anything
    // a shell would re-parse.
    const started = spawnSync(
        'tmux',
        tmuxArgs(['new-session', '-d', '-s', sessionName, '-c', known.cwd, agent.binary]),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (started.status !== 0) {
        log(`✗ resume ${sessionName}: tmux refused (${(started.stderr ?? '').trim() || 'no detail'})`);
        return reply({ error: 'start_failed' });
    }
    log(`⟲ resume ${sessionName}: ${agent.binary} in ${known.cwd}`);
    return reply({ resumed: true });
};

export interface SessionExitRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
}

export interface SessionExitResult {
    subtype: 'agent.session.exit.result';
    requestId: string;
    sessionName: string;
    exited?: true;
    error?: string;
    at: string;
}

/**
 * What an ending session is asked to act on, in order.
 *
 * `C-c` first, to interrupt whatever is running and clear the input line —
 * without it a quit command typed next would land after whatever was already
 * half-typed there.
 *
 * Then the agent's own quit command, when it has one. This is the step the
 * first version lacked and the reason it did not work: Claude Code holds its
 * prompt through `C-c` and through `C-d` alike, so a session driven only by
 * key presses stayed exactly where it was and had to be reported as still
 * running. An agent that knows how to quit should be asked in its own words.
 *
 * `C-d` last, twice. End-of-input closes a REPL that has no quit command, and
 * closes the shell the agent leaves behind — a session whose last pane exits
 * is over. Harmless where it is not needed: the sequence stops the moment the
 * session is gone.
 *
 * Deliberately no `kill-session` at the end. A forced kill would make this
 * always succeed, at the cost of taking the choice away from an agent that was
 * mid-write.
 */
const EXIT_SIGNALS_BEFORE_QUIT: readonly string[][] = [['C-c']];
const EXIT_SIGNALS_AFTER_QUIT: readonly string[][] = [['C-d'], ['C-d']];
/** Time given to each signal before the next one is tried. */
export const SESSION_EXIT_STEP_MS = 1_500;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask a session to end, and report whether it did.
 *
 * Answers late on purpose: the whole point is to let the agent wind itself
 * down, so the reply has to wait long enough to know whether it did. A session
 * that is still there when the signals run out is reported as still there
 * rather than forced — "I asked and it refused" is a true answer, and a phone
 * that can silently destroy a working agent is a worse thing to have built.
 */
export const handleSessionExitRequest = (
    req: SessionExitRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.session.exit.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const sessionName = req.sessionName;
    const requestId = req.requestId;
    const answer = (fields: Partial<SessionExitResult>): true => {
        send({
            subtype: 'agent.session.exit.result',
            requestId,
            sessionName,
            at: new Date().toISOString(),
            ...fields,
        });
        return true;
    };

    // Same budget as resume and as a submitted command: ending a session is a
    // session-lifecycle action, and pricing it like a keystroke would let a
    // flood through the cheaper door.
    if (!checkRateLimit(sessionName, undefined, SUBMIT_COST)) return answer({ error: 'rate_limited' });
    if (!sessionExists(sessionName)) return answer({ error: 'unknown_session' });

    // The agent's own quit command, if this machine recorded which agent it is
    // and that agent has one. A session the registry never saw still gets the
    // signals — less likely to work, but nothing here depends on the record.
    const quitCommand = REMOTE_AGENTS.find(
        (a) => a.kind === recallSession(sessionName)?.agentKind,
    )?.quitCommand;

    void (async () => {
        // Stop as soon as it worked — anything sent after the session is gone
        // lands in whatever tmux gives that name next.
        const stillThere = () => sessionExists(sessionName);
        for (const tokens of EXIT_SIGNALS_BEFORE_QUIT) {
            if (!stillThere()) break;
            injectNamedKeys(sessionName, tokens);
            await wait(SESSION_EXIT_STEP_MS);
        }
        if (quitCommand && stillThere()) {
            injectKeys(sessionName, quitCommand);
            await wait(SESSION_EXIT_STEP_MS);
        }
        for (const tokens of EXIT_SIGNALS_AFTER_QUIT) {
            if (!stillThere()) break;
            injectNamedKeys(sessionName, tokens);
            await wait(SESSION_EXIT_STEP_MS);
        }
        if (sessionExists(sessionName)) {
            log(`✗ exit ${sessionName}: still running after the exit signals`);
            answer({ error: 'still_running' });
            return;
        }
        log(`⏻ exit ${sessionName}: ended`);
        answer({ exited: true });
    })();
    return true;
};

export interface SessionForgetRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
}

export interface SessionForgetResult {
    subtype: 'agent.session.forget.result';
    requestId: string;
    sessionName: string;
    forgotten?: true;
    error?: string;
    at: string;
}

/**
 * Delete one ended session from this machine's record, and say what happened.
 * Returns true when the message was ours to answer.
 *
 * The mirror of resume, and destructive where that one is constructive: it
 * takes the entry out of the registry, which is the same file resume reads its
 * whitelist from. After this the session is neither offered nor startable, and
 * nothing puts it back — `rememberSessions` only writes down sessions that are
 * running, so only actually running that name again restores it.
 *
 * The refusals: unknown name is nothing to delete rather than something to
 * guess at. Still running means it is not a past session at all — the phone is
 * looking at a live one, and ending it is a different request that this must
 * not quietly stand in for.
 */
export const handleSessionForgetRequest = (
    req: SessionForgetRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.session.forget.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const sessionName = req.sessionName;
    const reply = (fields: Partial<SessionForgetResult>): true => {
        send({
            subtype: 'agent.session.forget.result' as const,
            requestId: req.requestId,
            sessionName,
            at: new Date().toISOString(),
            ...fields,
        });
        return true;
    };

    // Charged like a submitted command: it writes to disk and is irreversible,
    // so it shares the budget with the paths that start and stop processes.
    if (!checkRateLimit(sessionName, undefined, SUBMIT_COST)) return reply({ error: 'rate_limited' });

    if (sessionExists(sessionName)) return reply({ error: 'still_running' });
    if (!forgetSession(sessionName)) {
        log(`✗ forget ${sessionName}: never seen on this machine`);
        return reply({ error: 'unknown_session' });
    }

    log(`🗑 forget ${sessionName}: dropped from this machine's record`);
    return reply({ forgotten: true });
};

/** Whether tmux already holds a session by this name. */
const sessionExists = (name: string): boolean =>
    spawnSync('tmux', tmuxArgs(['has-session', '-t', name]), {
        stdio: ['ignore', 'ignore', 'ignore'],
    }).status === 0;

// ─── Deep pull: scrollback above the live window ───────────────────
//
// The live stream captures a fixed window and every frame is capped at
// SCREEN_PEEK_MAX_BYTES, so output older than that window is unreachable from
// the phone. Neither cap is the lever: a deeper STREAM_CAPTURE_LINES only grows
// what each frame captures and then throws away, and SCREEN_PEEK_MAX_BYTES is
// sized for API Gateway's 32KB WS frame. So history is pulled instead of
// streamed — one page per request, walking upward.

/** Ceiling on one page. A page past the frame limit arrives truncated anyway,
 *  so let the caller ask for less rather than pay for a capture we discard. */
export const SCREEN_HISTORY_MAX_LINES = 200;
const SCREEN_HISTORY_DEFAULT_LINES = 100;

export interface ScreenHistoryRequest {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    requestId?: string;
    /**
     * How many lines of scrollback the caller already holds above the visible
     * pane — the `historyLines` of its newest frame plus every history line it
     * has pulled since. 0 asks for the page directly above the visible pane.
     *
     * The caller says this rather than the daemon assuming STREAM_CAPTURE_LINES,
     * because the byte cap trims frames from the top and a caller holding fewer
     * lines than the capture asked for would otherwise be handed a page that
     * starts above its own content, with the gap unreachable forever after.
     * Absent falls back to the constant — the untruncated case.
     */
    before?: number;
    /** Page size. Clamped to SCREEN_HISTORY_MAX_LINES. */
    lines?: number;
}

export interface ScreenHistorySnapshot {
    subtype: 'agent.screen.history.snapshot';
    requestId: string;
    sessionName: string;
    content?: string;
    /** Echo of the request's offset, so a caller with several pages in flight
     *  can tell which one this is. */
    before?: number;
    /** Lines actually returned — what the caller adds to `before` for the next
     *  page. Smaller than asked when the payload cap trimmed the page. */
    lines?: number;
    /** Whether older lines still exist above this page. */
    hasMore?: boolean;
    truncated?: boolean;
    /** The page sealed for the stream's subscriber — present INSTEAD of
     *  `content` whenever the stream it belongs to is encrypted. */
    encrypted?: EncryptedEphemeralPayload;
    error?: string;
    capturedAt: string;
}

/** These become tmux argv and page arithmetic; a fractional, negative or
 *  non-numeric one has no sensible coercion, so it is refused. */
const isPageOffset = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** How many lines of scrollback the pane is holding, or null when tmux won't
 *  say — which is also how a dead pane answers. */
const paneHistorySize = (sessionName: string): number | null => {
    const r = spawnSync(
        'tmux',
        tmuxArgs(['display-message', '-p', '-t', sessionName, '#{history_size}']),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    const size = Number((r.stdout ?? '').trim());
    return Number.isInteger(size) && size >= 0 ? size : null;
};

/** Capture one explicit range. tmux line 0 is the top of the visible pane and
 *  negative numbers reach into the history, so both bounds are negative here. */
const capturePaneRange = (
    sessionName: string,
    start: number,
    end: number,
): { content: string; truncated: boolean } | null => {
    const r = spawnSync(
        'tmux',
        tmuxArgs([
            'capture-pane', '-p', '-e', '-t', sessionName,
            '-S', String(start), '-E', String(end),
        ]),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    return capToFrameLimit(r.stdout ?? '');
};

const countLines = (content: string): number =>
    content ? content.replace(/\n$/, '').split('\n').length : 0;

/**
 * Answer a phone's request for one page of scrollback above the live window.
 * Returns true when the message was ours to answer, so the caller stops routing
 * it; the reply goes out through `send`, after the seal when there is one.
 *
 * Same security posture as the one-shot peek it sits beside — addressed to this
 * machine, only for sessions the inventory already exposes, charged to the same
 * per-session token bucket, and reading the pane through tmux and nothing else —
 * plus one the peek does not have: it answers ONLY under a live stream lease.
 * That is what makes E2EE possible here. History is the same pane text the
 * frames carry, so on an encrypted stream it is sealed for the same subscriber
 * key and never falls back to plaintext; without a lease there is no key to
 * seal for, and a pull that answered anyway would be the downgrade the stream
 * half refuses.
 */
export const handleScreenHistoryRequest = (
    req: ScreenHistoryRequest,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.screen.history.request') return false;
    if (!req.requestId || !req.sessionName) return false;
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;

    const base = {
        subtype: 'agent.screen.history.snapshot' as const,
        requestId: req.requestId,
        sessionName: req.sessionName,
        capturedAt: new Date().toISOString(),
    };
    /** Answer and claim the message. */
    const reply = (fields: Partial<ScreenHistorySnapshot>): true => {
        send({ ...base, ...fields });
        return true;
    };

    const before = req.before ?? STREAM_CAPTURE_LINES;
    const asked = req.lines ?? SCREEN_HISTORY_DEFAULT_LINES;
    if (!isPageOffset(before) || !isPageOffset(asked) || asked === 0) {
        return reply({ error: 'bad_range' });
    }
    const lines = Math.min(asked, SCREEN_HISTORY_MAX_LINES);

    if (!checkRateLimit(`screen:${req.sessionName}`)) return reply({ error: 'rate_limited' });
    if (!isInventoried(req.sessionName)) {
        return reply({ error: 'unknown_session' });
    }
    const stream = activeStreams.get(req.sessionName);
    if (!stream) return reply({ error: 'no_stream' });

    const depth = paneHistorySize(req.sessionName);
    if (depth === null) return reply({ error: 'capture_failed' });

    // Everything below this line the caller already has.
    const held = before;
    // Scrolled past the oldest line. An empty page rather than an error — the
    // view stops, and stopping is not a failure. Nothing to seal either.
    if (depth <= held) return reply({ before, content: '', lines: 0, hasMore: false });

    const captured = capturePaneRange(req.sessionName, -(held + lines), -(held + 1));
    if (!captured) return reply({ error: 'capture_failed' });

    const returned = countLines(captured.content);
    const page = {
        before,
        lines: returned,
        truncated: captured.truncated,
        hasMore: depth > held + returned,
    };
    if (!stream.subscriberPublicKey) return reply({ ...page, content: captured.content });

    // Encrypted stream: the page rides ONLY inside the envelope, and a failed
    // seal is an error rather than a plaintext page — the same rule the frame
    // path follows when its encrypt fails.
    encryptEphemeral(captured.content, stream.subscriberPublicKey)
        .then((encrypted) => send({ ...base, ...page, encrypted }))
        .catch((err) => {
            log(`⧉ history ${req.sessionName}: seal failed (${err instanceof Error ? err.message : err})`);
            send({ ...base, error: 'encrypt_failed' });
        });
    return true;
};

/**
 * Fit one capture into a WS frame. Cuts from the TOP: the bottom of the range
 * is the part adjacent to what the reader already has — the live pane for a
 * snapshot, the page below it for a history page — so cutting the other end
 * would leave a hole exactly where the text has to join up.
 */
const capToFrameLimit = (raw: string): { content: string; truncated: boolean } => {
    let content = raw;
    let truncated = false;
    while (Buffer.byteLength(content, 'utf-8') > SCREEN_PEEK_MAX_BYTES) {
        const cut = content.indexOf('\n', Math.floor(content.length / 8));
        content = cut > 0 ? content.slice(cut + 1) : content.slice(-SCREEN_PEEK_MAX_BYTES);
        truncated = true;
    }
    return { content, truncated };
};

/** Raw pane capture + size cap. Shared by the request path and the
 *  post-injection auto-snapshot. */
const capturePane = (
    sessionName: string,
    escapes = false,
    lines: number = SCREEN_PEEK_LINES,
): { content: string; truncated: boolean } | null => {
    // `-e` keeps the ANSI/color escapes the live mirror renders; the
    // screen-peek path leaves it off so its <pre> renderer stays plain text.
    // `lines` sets how far back the capture reaches — the live stream grabs
    // more history so the mirror has room to scroll; SCREEN_PEEK_MAX_BYTES
    // still caps the payload below.
    const captureArgs = escapes
        ? ['capture-pane', '-p', '-e', '-t', sessionName, '-S', `-${lines}`]
        : ['capture-pane', '-p', '-t', sessionName, '-S', `-${lines}`];
    const r = spawnSync('tmux', tmuxArgs(captureArgs), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    return capToFrameLimit(r.stdout ?? '');
};

/**
 * Where the cursor sits, in the coordinates of a captured frame.
 *
 * `capture-pane` gives cells and colors but no cursor, so the mirror has never
 * drawn one — which makes an arrow key indistinguishable from a dropped one.
 * tmux reports the position separately; `pane_height` is what turns a
 * pane-relative row into a row of the captured text, since the capture reaches
 * back into scrollback and the visible pane is only its last `pane_height`
 * lines. `history_size` rides along in the same answer — one format string,
 * no second spawn — and tells the viewer how deep the buffer under that
 * window is.
 *
 * Read only for frames that are actually about to be sent — one extra tmux
 * spawn per SENT frame rather than per tick.
 */
const capturePaneCursor = (sessionName: string): PaneGeometry | null => {
    const r = spawnSync(
        'tmux',
        tmuxArgs([
            'display-message', '-p', '-t', sessionName,
            '#{cursor_x},#{cursor_y},#{pane_height},#{history_size}',
        ]),
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (r.status !== 0) return null;
    return parsePaneGeometry(r.stdout ?? '');
};

export interface PaneGeometry {
    x: number;
    y: number;
    height: number;
    /** Lines of scrollback the pane holds above the visible rows. Tells the
     *  viewer where this frame's window sits in the buffer, which is what lets
     *  it record the lines that scroll past without matching text. Absent when
     *  tmux did not answer with a usable number. */
    historySize?: number;
}

/**
 * Read the one tmux answer the frame path already asks for per tick.
 *
 * The depth is parsed separately from the cursor on purpose: a tmux that does
 * not report `history_size` still reports the cursor, and refusing the whole
 * answer over the missing field would cost every frame its cursor — a
 * regression in exchange for a feature.
 */
export const parsePaneGeometry = (raw: string): PaneGeometry | null => {
    const fields = raw.trim().split(',');
    const [x, y, height] = fields.map(Number);
    if (![x, y, height].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    // An absent field is NOT a depth of zero, and `Number('')` is 0 — so the
    // raw field has to be checked before it is converted. Zero is the answer a
    // freshly cleared pane gives, and the viewer reads a drop to zero as that
    // clear; letting an empty answer arrive as one would fake the clear and
    // make the viewer re-record output it already holds.
    const depth = fields.length > 3 && fields[3] !== '' ? Number(fields[3]) : NaN;
    if (!Number.isSafeInteger(depth) || depth < 0) return { x, y, height };
    return { x, y, height, historySize: depth };
};

/**
 * Translate the cursor into an index into the lines the frame carries.
 *
 * The visible pane is the tail of the capture, so the cursor's row counts back
 * from the end — which also makes this correct after the byte cap has cut lines
 * off the top. A cursor that falls outside what the frame carries returns null
 * and simply is not drawn.
 */
export const cursorLineFor = (
    content: string,
    cursor: { x: number; y: number; height: number },
): { line: number; col: number } | null => {
    const rows = paneRowCount(content);
    const line = rows - cursor.height + cursor.y;
    if (line < 0 || line >= rows) return null;
    return { line, col: cursor.x };
};

/** capture-pane ends the last row with a newline, which split() turns into a
 *  trailing empty element that is not a pane row. */
const paneRowCount = (content: string): number => {
    const lines = content.split('\n');
    return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
};

/**
 * How many of a frame's lines are scrollback rather than the visible pane.
 *
 * This is the number the viewer hands back as `before` when it asks for
 * history. STREAM_CAPTURE_LINES is only what the capture ASKED for: the byte
 * cap trims from the top, and a coloured TUI pane hits that cap routinely, so
 * assuming the viewer holds the full window would start the first history page
 * above what it actually has — leaving a gap no later page can reach, since
 * every later page walks further up.
 */
export const historyLinesIn = (content: string, paneHeight: number): number =>
    Math.max(0, paneRowCount(content) - paneHeight);

/** Delays after a key injection at which the pane is re-captured and pushed
 *  to the phone unsolicited. The first frame lands right after most TUI
 *  redraws; the second catches slow animations and is skipped when nothing
 *  changed since the first. */
const INJECT_SNAPSHOT_DELAYS_MS = [250, 900];

const pendingInjectSnapshots = new Map<string, ReturnType<typeof setTimeout>[]>();

/**
 * After the phone injects keys, push fresh frames instead of waiting for its
 * next screen request — the phone's post-tap re-pull raced the key landing
 * (its timer starts at tap time, the key lands a REST+WS hop later), so it
 * often re-captured the pre-keypress screen and the next update was a full
 * auto-refresh period away. Unsolicited frames carry no requestId; the phone
 * matches them by deviceId + sessionName. A newer tap cancels pending
 * captures so a burst of arrow presses yields frames after the LAST press.
 */
export const scheduleInjectSnapshots = (
    sessionName: string,
    send: (data: Record<string, unknown>) => void,
    delays: number[] = INJECT_SNAPSHOT_DELAYS_MS,
): void => {
    // These snapshots exist to show the phone what a keystroke did when nobody
    // is mirroring the pane. A live stream already repaints it at the burst
    // cadence, so scheduling them there is two extra blocking captures and two
    // extra sends per keystroke — outside the stream's own send budget, which
    // is exactly the cost the budget exists to bound.
    if (activeStreams.has(sessionName)) return;
    for (const t of pendingInjectSnapshots.get(sessionName) ?? []) clearTimeout(t);
    let lastContent: string | null = null;
    const timers = delays.map((delay) =>
        setTimeout(() => {
            const captured = capturePane(sessionName);
            if (!captured || captured.content === lastContent) return;
            lastContent = captured.content;
            send({
                subtype: 'agent.screen.snapshot',
                sessionName,
                capturedAt: new Date().toISOString(),
                ...captured,
            });
        }, delay),
    );
    pendingInjectSnapshots.set(sessionName, timers);
};

// ─── Live mirror: continuous pane streaming ──────────────────
// Extends screen-peek from pull (one snapshot per request) to a subscribed
// stream over the same ephemeral relay, same security posture (only
// inventory-visible sessions, addressed by deviceId, same rate-limit bucket).
//
// E2EE: when the subscriber sends its device public key with stream.start,
// every frame's pane content rides inside an ECDH P-256 + AES-256-GCM
// envelope only that phone can open (see crypto.ts encryptEphemeral). The
// relay stays pass-through. Without a key (older client / E2EE not set up)
// frames fall back to plaintext — the web keeps its warning banner for that
// case. Once a stream is encrypted an encrypt failure DROPS the frame; it
// never downgrades to plaintext mid-stream.
export interface StreamControl {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    /** Subscriber's device public key (Base64 SPKI) — presence turns on E2EE. */
    subscriberPublicKey?: string;
    /**
     * Subscriber promises to send `agent.stream.renew` while it's watching.
     * Only such a subscriber gets the short lease; clients that predate the
     * renew protocol keep the 5-minute orphan guard (see STREAM_LEASE_MS).
     */
    renew?: boolean;
}

// ~2.5 fps idle ceiling. Cadence + diff-gating + the per-second send budget
// are the ONLY bound on API Gateway WS cost (the $default route has no
// per-message limit), so keep it modest and let unchanged frames drop.
// How far back the live-stream capture reaches — more than the screen-peek
// window so the mirror has scrollback to scroll through. SCREEN_PEEK_MAX_BYTES
// still caps the actual payload, so very wide panes get top-truncated.
export const STREAM_CAPTURE_LINES = 200;
export const STREAM_INTERVAL_MS = 400;
// Burst cadence: right after a keystroke lands, the pane IS what the user is
// staring at, so captures tighten for BURST_WINDOW_MS and then fall back to
// the idle cadence. The window is what keeps this affordable — one keypress
// costs a bounded number of extra frames instead of raising the steady rate.
export const BURST_INTERVAL_MS = 120;
export const BURST_WINDOW_MS = 2_500;
// Cost bound the burst must not break: MAX_CONCURRENT_STREAMS × 8 = 24 msg/s
// worst case, under half of the API Gateway WS stage throttle (50 rps) that is
// SHARED across every user, so a bursting host still leaves headroom for push
// delivery and presence. At BURST_INTERVAL_MS the chain tops out at 8.3 fps,
// so this budget bites only in the last fraction of a fully bursting second —
// it is what holds the line if the burst cadence is ever tightened further.
export const MAX_FRAMES_PER_SEC = 8;

/**
 * Delay before the next capture: burst while the last input is still echoing,
 * idle otherwise. Exclusive at the boundary — exactly BURST_WINDOW_MS after
 * the input is already idle, so the window can't stretch. A lastInputAt in the
 * future (wall-clock jump) reads as fresh input rather than as an expired
 * window: bursting is the recoverable side of that.
 */
export const streamCadence = (lastInputAt: number | null, now: number): number =>
    lastInputAt !== null && now - lastInputAt < BURST_WINDOW_MS ? BURST_INTERVAL_MS : STREAM_INTERVAL_MS;

/** Rolling one-second send budget for a single stream. */
export interface FrameBudget {
    windowStartedAt: number;
    sent: number;
}

/**
 * Claim one send from the budget, rolling the window over when the second has
 * passed. False means this tick must skip WITHOUT marking the frame as sent —
 * the diff-gate would otherwise swallow that content for good.
 */
/** Is there budget left this second? A peek, so a tick can decline to pay for a
 *  blocking capture it could not send anyway — spending the token here instead
 *  would burn budget on ticks the diff-gate goes on to skip. */
export const hasFrameBudget = (budget: FrameBudget, now: number): boolean =>
    now - budget.windowStartedAt >= 1_000 || now < budget.windowStartedAt
        ? true
        : budget.sent < MAX_FRAMES_PER_SEC;

export const claimFrameSend = (budget: FrameBudget, now: number): boolean => {
    // `now < windowStartedAt` = the clock ran backwards (NTP step, resume).
    // Without the guard the window never rolls again and a spent budget
    // freezes the mirror for the whole regression — same failure streamCadence
    // already defends against, so the two must agree.
    if (now - budget.windowStartedAt >= 1_000 || now < budget.windowStartedAt) {
        budget.windowStartedAt = now;
        budget.sent = 0;
    }
    if (budget.sent >= MAX_FRAMES_PER_SEC) return false;
    budget.sent++;
    return true;
};
// Orphan guard for subscribers that can't renew (clients older than the renew
// protocol): a phone that dies without sending agent.stream.stop must not leak
// an interval forever. Auto-stop after this long; the phone re-subscribes on
// reopen.
const STREAM_MAX_MS = 5 * 60_000;
// Lease for a renewal-capable subscriber (`start` carried `renew: true`).
// stream.stop is NOT a reliable slot-release signal: the native terminal runs
// in its own WebView that the OS destroys on swipe-back, killing the page mid-
// flight — no unmount, no stop, and the relay is pass-through so we never see
// the phone's socket drop either. Three such opens used to wedge
// MAX_CONCURRENT_STREAMS for a full STREAM_MAX_MS with every retry answering
// stream_limit. A lease inverts the burden: the viewer must keep proving it's
// there.
//
// This is also the worst-case wait before a vanished viewer's slot comes back,
// so it wants to be short — but a lease can only be as tight as the proof is
// frequent. At the web's 5s renew cadence this tolerates 3 consecutive dropped
// renews, the same margin as before, while cutting the wedge from 5 minutes to
// 15 seconds. A viewer that loses the race gets its stream reaped and re-
// subscribes on the next renew (see the stream_gone reply below).
export const STREAM_LEASE_MS = 15_000;
// How recent a renew must be for a slot-holder to count as provably watched
// when the cap needs a victim. Deliberately tighter than the lease: the lease
// is the self-reap deadline and wants slack for dropped renews, but at the cap
// that slack is exactly the window in which a swiped-away WebView's ghost
// answers every new subscriber with stream_limit. One renew beat (the web's
// 5s cadence) plus jitter is proof enough under contention; a live viewer
// evicted over a single dropped renew learns via stream_gone on its next
// renew and re-subscribes.
export const STREAM_RENEW_FRESH_MS = 8_000;
// Per-listener concurrency guard: the API Gateway WS stage throttle (50 rps)
// is SHARED across every user, so a runaway machine (many sessions, or a
// client re-subscribe bug) streaming at 2.5 fps each can starve push delivery
// and presence for everyone. One phone watches one session at a time; 3 leaves
// headroom for multiple devices while capping the blast radius of one host.
export const MAX_CONCURRENT_STREAMS = 3;
// Fail-closed guard: consecutive encrypt failures (malformed subscriber key)
// stop the stream with an error frame instead of retrying forever.
const STREAM_MAX_ENCRYPT_FAILURES = 3;

// R2 instrumentation: the daemon's outbound send() IS the API Gateway $default
// inbound message (1 Lambda + DDB ops + N PostToConnection each), so counting
// frames/bytes HERE measures the real cloud cost of a live stream. Rolled up to
// the log every STREAM_LOG_INTERVAL_MS and summarized on stop — the data that
// decides cloud-throttled (B-lite) vs direct/Tailscale (B-full).
const STREAM_LOG_INTERVAL_MS = 5_000;

interface StreamStats {
    startedAt: number;
    frames: number; // frames actually sent (post diff-gate)
    bytes: number; // payload bytes sent
    /** The burst phase's share of frames/bytes, and the wall time spent at the
     *  burst cadence — burst vs idle cost is the question B-full turns on, and
     *  a single blended fps hides it. Idle is the remainder. */
    framesBurst: number;
    bytesBurst: number;
    burstMs: number;
    skipped: number; // ticks that sent nothing (diff-gate, or the send budget)
    rateCapped: number; // subset of `skipped` refused by MAX_FRAMES_PER_SEC
    lastLogAt: number;
    lastLogFrames: number;
    lastLogBytes: number;
    lastLogFramesBurst: number;
    lastLogBurstMs: number;
}

interface ActiveStream {
    /** Handle of the ONE armed tick. The capture loop re-arms itself every
     *  tick (the cadence changes between ticks), so this is replaced each
     *  time — stopping a stream means clearing whatever is current. */
    timer: ReturnType<typeof setTimeout>;
    stats: StreamStats;
    /** When input last landed in this pane, or null if none has. Drives the
     *  burst cadence; set by noteStreamInput from the shared inject path. */
    lastInputAt: number | null;
    /** Wall-clock deadline; the capture tick reaps the stream once it passes. */
    expiresAt: number;
    /** Subscriber renews — i.e. its silence is proof it's gone, not just quiet. */
    renewing: boolean;
    /** Last proof of watching (start or renew). Eviction freshness reads this;
     *  the lease above stays the reaping deadline. */
    renewedAt: number;
    /** Set when the subscriber handed over an E2EE key at start. Outbound
     *  frames are encrypted for it, so inbound plaintext input is refused
     *  rather than typed — the inbound half must not be the one leg in clear. */
    subscriberPublicKey?: string;
    /** Consecutive failed decrypts of sealed input on THIS incarnation. The
     *  subscriber-key binding gates who may enqueue an ECDH derive, not how
     *  many can fail, so this is what stops a flood; a successful decrypt
     *  clears it, and a re-subscribe mints a fresh entry. */
    inputDecryptFailures: number;
    /** Replace an IDLE-armed tick with an immediate burst tick. Input landing
     *  just after an idle tick must not wait out the remaining ~400ms gap —
     *  that gap IS the latency the burst exists to remove. No-op while a
     *  burst tick is armed, so a keystroke flurry can't starve the chain. */
    wake: () => void;
}

/** How far a start (and each renew) pushes the deadline out. */
const leaseFor = (renewing: boolean): number => (renewing ? STREAM_LEASE_MS : STREAM_MAX_MS);

const activeStreams = new Map<string, ActiveStream>();

/** Inbound key ordering, one per (streamed session, sender device) — see the
 *  `agent.command.input` section below. Lives here so stopStream can drop them
 *  with the lease they belong to. Keyed `<session>#<deviceId>`, or the bare
 *  session name from a relay too old to stamp the sender. */
const inputSequencers = new Map<string, InputSequencer<PendingInput>>();

/** Frames per second for one cadence phase. A phase that got no wall time in
 *  the window (a stream that never bursted) reads 0.0, never NaN. */
const phaseFps = (frames: number, ms: number): string => (ms > 0 ? (frames / (ms / 1000)).toFixed(1) : '0.0');

const maybeLogStreamStats = (sessionName: string, stats: StreamStats): void => {
    const elapsed = Date.now() - stats.lastLogAt;
    if (elapsed < STREAM_LOG_INTERVAL_MS) return;
    const secs = elapsed / 1000;
    const frames = stats.frames - stats.lastLogFrames;
    const fps = frames / secs;
    const kbps = (stats.bytes - stats.lastLogBytes) / 1024 / secs;
    // burstMs is charged when a burst tick is armed, so it can overshoot the
    // window by at most one interval — phaseFps clamps the idle remainder.
    const burstMs = stats.burstMs - stats.lastLogBurstMs;
    const burstFrames = stats.framesBurst - stats.lastLogFramesBurst;
    log(
        `⧉ stream ${sessionName}: ${fps.toFixed(1)} fps, ${kbps.toFixed(1)} KB/s ` +
            `(${stats.frames} sent, ${stats.skipped} skipped incl. ${stats.rateCapped} rate-capped) ` +
            `[burst ${phaseFps(burstFrames, burstMs)} fps · idle ${phaseFps(frames - burstFrames, elapsed - burstMs)} fps]`,
    );
    stats.lastLogAt = Date.now();
    stats.lastLogFrames = stats.frames;
    stats.lastLogBytes = stats.bytes;
    stats.lastLogFramesBurst = stats.framesBurst;
    stats.lastLogBurstMs = stats.burstMs;
};

/** A keystroke landed in this pane, so the next captures run at the burst
 *  cadence and the echo is visible instead of up to STREAM_INTERVAL_MS late.
 *  Called from the shared inject helpers, which is what both the ephemeral
 *  (agent.command.input) and the REST (agent.command) paths funnel through. */
const noteStreamInput = (sessionName: string): void => {
    const entry = activeStreams.get(sessionName);
    if (!entry) return;
    entry.lastInputAt = Date.now();
    entry.wake();
};

export const stopStream = (sessionName: string): void => {
    const entry = activeStreams.get(sessionName);
    if (!entry) return;
    clearTimeout(entry.timer);
    activeStreams.delete(sessionName);
    // The next stream is a new run: a sequencer carrying this one's high-water
    // mark would swallow its first keys if the sender restarts its counter.
    // Every sender that typed into this session holds its own, so drop the
    // whole `<session>#…` family, not just the bare-name key.
    for (const [key, sequencer] of inputSequencers) {
        if (key !== sessionName && !key.startsWith(`${sessionName}#`)) continue;
        sequencer.reset();
        inputSequencers.delete(key);
    }
    const { stats } = entry;
    const secs = Math.max(0.001, (Date.now() - stats.startedAt) / 1000);
    log(
        `⧉ stream ${sessionName} stopped: ${stats.frames} frames / ` +
            `${(stats.bytes / 1024).toFixed(1)} KB over ${secs.toFixed(1)}s ` +
            `(${(stats.frames / secs).toFixed(1)} fps avg, ${stats.skipped} skipped incl. ${stats.rateCapped} rate-capped) ` +
            `[burst ${stats.framesBurst} frames / ${(stats.bytesBurst / 1024).toFixed(1)} KB ` +
            `over ${(stats.burstMs / 1000).toFixed(1)}s = ${phaseFps(stats.framesBurst, stats.burstMs)} fps]`,
    );
};

export const stopAllStreams = (): void => {
    // Route through stopStream so each stream emits its summary line.
    for (const sessionName of [...activeStreams.keys()]) stopStream(sessionName);
};

/** Wire shape of one live-mirror data frame (before the relay's ephemeral wrap). */
export type StreamFramePayload = {
    subtype: 'agent.stream.frame';
    sessionName: string;
    capturedAt: string;
    truncated: boolean;
    /** Capture-order stamp — attached at send time, not by buildStreamFrame. */
    seq?: number;
    /** Stream incarnation (stats.startedAt) — lets the receiver reset its
     *  seq high-water mark when the daemon restarts the stream. */
    epoch?: number;
    /** Where to draw the cursor: a 0-based index into the lines this frame
     *  carries, and a 0-based CELL column (not a string index — a wide glyph
     *  spans two cells, which is what the viewer positions by). Absent when the
     *  cursor is outside the captured region. Deliberately outside the E2EE
     *  envelope, like sessionName and seq: a coordinate without the text it
     *  points into says nothing, and keeping it in the clear means the viewer
     *  can place the cursor before the pane content finishes decrypting. */
    cursorLine?: number;
    cursorCol?: number;
    /** How many of this frame's lines are scrollback rather than the visible
     *  pane — what the viewer sends back as `before` when it pulls history.
     *  Fewer than STREAM_CAPTURE_LINES whenever the byte cap trimmed the frame,
     *  which is exactly the case a constant would get wrong. Absent when the
     *  pane geometry could not be read; the viewer then falls back to the
     *  constant. Plaintext for the same reason the cursor is: a line count
     *  without the lines says nothing. */
    historyLines?: number;
    /** How much scrollback the PANE holds above its visible rows — the depth
     *  this frame's window sits in, where `historyLines` is only the slice of
     *  it the frame carries. Together they place the frame's top edge in the
     *  buffer, which is what lets a viewer record the lines that scroll past
     *  without matching text (a redrawing TUI defeats text matching), and lets
     *  it see the buffer being cleared as the depth dropping. Absent when tmux
     *  would not say. Plaintext for the same reason the cursor is: a line count
     *  without the lines says nothing. */
    historySize?: number;
    /** Plaintext pane content — only on unencrypted streams. */
    content?: string;
    /** E2EE envelope — replaces `content` on encrypted streams. */
    encrypted?: EncryptedEphemeralPayload;
};

/** Wire shape of a live-mirror error frame — same subtype, no pane data.
 *  `input_rejected` refuses an ephemeral `agent.command.input`; it rides this
 *  frame so a viewer already handling stream errors can fall back to the REST
 *  push path without a second error channel. */
export type StreamErrorFrame = {
    subtype: 'agent.stream.frame';
    sessionName: string;
    error: 'unknown_session' | 'e2ee_unavailable' | 'encrypt_failed' | 'stream_limit' | 'stream_gone' | 'input_rejected';
    /** `input_rejected` only: the refused message's ordering stamp echoed back.
     *  A sender with several keystrokes in flight can't tell which one was
     *  refused without it. Absent when the message carried no usable stamp. */
    seq?: number;
    epoch?: number;
    /** `input_rejected` only: the refused sender's deviceId, echoed so a second
     *  device whose (seq, epoch) happens to collide doesn't claim the refusal
     *  and fire a REST resend for an input that was never refused. */
    inputDeviceId?: string;
};

/**
 * Per-listener concurrency guard, as a pure predicate so the boundary is
 * unit-testable without touching the module-scope `activeStreams` map.
 */
export const isStreamCapReached = (activeCount: number): boolean =>
    activeCount >= MAX_CONCURRENT_STREAMS;

/**
 * At the cap, hand the slot to the new subscriber when the stalest holder
 * can't prove it's still watching — a renew gone stale (STREAM_RENEW_FRESH_MS),
 * an expired lease, or a client too old to renew at all (those hold a slot for
 * STREAM_MAX_MS on nothing but hope, and a cached web build can keep producing
 * them long after a deploy). Three actively-renewing viewers are all real, so
 * that case still refuses.
 * Returns the evicted session name, or null when every holder is live.
 */
const evictStalestStream = (now: number): string | null => {
    let victim: { name: string; expiresAt: number } | null = null;
    for (const [name, entry] of activeStreams) {
        if (entry.renewing && now - entry.renewedAt < STREAM_RENEW_FRESH_MS) continue; // provably watched
        if (!victim || entry.expiresAt < victim.expiresAt) victim = { name, expiresAt: entry.expiresAt };
    }
    if (!victim) return null;
    log(`⧉ stream ${victim.name}: evicted — slot handed to a newer subscriber (no fresh renew)`);
    stopStream(victim.name);
    return victim.name;
};

const streamErrorFrame = (
    sessionName: string,
    error: StreamErrorFrame['error'],
    /** The message being refused, when there is one to echo. */
    echo?: { seq?: unknown; epoch?: unknown; deviceId?: unknown },
): StreamErrorFrame => {
    const frame: StreamErrorFrame = { subtype: 'agent.stream.frame', sessionName, error };
    // A malformed message may carry no stamp at all, or garbage — omitting the
    // field beats echoing something the sender can't match.
    if (isSeqNumber(echo?.seq)) frame.seq = echo.seq;
    if (isSeqNumber(echo?.epoch)) frame.epoch = echo.epoch;
    if (typeof echo?.deviceId === 'string' && echo.deviceId) frame.inputDeviceId = echo.deviceId;
    return frame;
};

/**
 * Build the wire payload for one stream frame. With a subscriber public key
 * the pane content rides ONLY inside the E2EE envelope; an encrypt failure
 * (bad key, crypto not ready on the first tick) returns null so the caller
 * drops the frame — an encrypted stream never leaks a plaintext frame.
 */
export const buildStreamFrame = async (
    captured: { content: string; truncated: boolean },
    sessionName: string,
    subscriberPublicKey?: string,
    meta?: {
        cursor?: { line: number; col: number } | null;
        historyLines?: number;
        historySize?: number;
    },
): Promise<StreamFramePayload | null> => {
    const cursor = meta?.cursor;
    const base = {
        subtype: 'agent.stream.frame' as const,
        sessionName,
        capturedAt: new Date().toISOString(),
        truncated: captured.truncated,
        ...(cursor ? { cursorLine: cursor.line, cursorCol: cursor.col } : {}),
        ...(meta?.historyLines === undefined ? {} : { historyLines: meta.historyLines }),
        ...(meta?.historySize === undefined ? {} : { historySize: meta.historySize }),
    };
    if (!subscriberPublicKey) return { ...base, content: captured.content };
    try {
        const encrypted = await encryptEphemeral(captured.content, subscriberPublicKey);
        return { ...base, encrypted };
    } catch (err) {
        log(`⧉ stream ${sessionName}: frame encrypt failed (${err instanceof Error ? err.message : err}) — frame dropped`);
        return null;
    }
};

/**
 * Handle agent.stream.start / agent.stream.stop. Returns true when the message
 * was a stream-control message (so the caller skips the one-shot screen-peek
 * path). start is idempotent — a repeat restarts the loop.
 */
// deep: over the body-length limit on purpose. Everything past the guards is
// one capture loop whose state (lastContent, wireSeq, encryptFailures, budget,
// and `stats` as the incarnation token) is only correct while it stays private
// to a single start. Hoisting it into a factory would turn those five into
// parameters and expose the incarnation invariant — the one that keeps an
// orphaned chain from capturing forever — to callers that have no reason to
// know it exists. Nothing outside needs the internals; deleting this deletes
// the live mirror whole.
export const handleStreamControl = (
    req: StreamControl,
    send: (data: Record<string, unknown>) => void,
): boolean => {
    if (req.subtype !== 'agent.stream.start' && req.subtype !== 'agent.stream.stop' && req.subtype !== 'agent.stream.renew') {
        return false;
    }
    // Every stream-control message names one machine, and the relay fans them
    // out to all of this user's connections — so decide addressing once, here.
    // Two machines can run the same tmux session name, and stop/renew carry no
    // other identity: without this gate a stop meant for one listener would
    // reach into the other's stream of that name (and a renew would refresh it).
    if (req.targetDeviceId !== computeListenerDeviceId()) return false;
    if (req.subtype === 'agent.stream.stop') {
        if (req.sessionName) stopStream(req.sessionName);
        return true;
    }
    // Lease renewal — the subscriber is still watching.
    if (req.subtype === 'agent.stream.renew') {
        if (!req.sessionName) return true;
        const entry = activeStreams.get(req.sessionName);
        if (entry) {
            entry.renewedAt = Date.now();
            entry.expiresAt = entry.renewedAt + leaseFor(entry.renewing);
            // Answer it. The renew used to succeed in silence, which left the
            // viewer with no way to tell a healthy quiet stream from a dead
            // one: the capture loop drops unchanged frames, so an agent that
            // stops to think and a daemon that stopped existing both produce
            // exactly nothing. This reply is the difference — it says the
            // daemon is here and still holds this lease, whatever the pane is
            // or is not doing.
            //
            // No pane content rides on it, so it is not sealed. That is not an
            // exception to the encryption rule but the reason the rule does not
            // reach here: there is nothing in this message a relay could read
            // that it did not already route.
            send({ subtype: 'agent.stream.renew.ok', sessionName: req.sessionName });
            return true;
        }
        // Addressed to us but we hold no such stream: it was reaped (lost
        // renews), evicted, or dropped when our socket last reconnected. The
        // viewer has no other way to learn that — it just keeps painting a
        // frozen pane under a LIVE badge — so tell it to re-subscribe. Renew
        // carries no subscriber key, so restarting it here would silently
        // downgrade an E2EE stream to plaintext; only the client can redo the
        // handshake.
        send(streamErrorFrame(req.sessionName, 'stream_gone'));
        return true;
    }
    const sessionName = req.sessionName;
    if (!sessionName) return true;
    if (!isInventoried(sessionName)) {
        send(streamErrorFrame(sessionName, 'unknown_session'));
        return true;
    }
    stopStream(sessionName); // idempotent restart (frees this session's slot first)
    // Concurrency guard AFTER the restart-stop: re-subscribing to an already
    // active session doesn't count against the cap, only a genuinely new one
    // does. Refuse the new stream instead of adding to the shared-throttle load.
    if (isStreamCapReached(activeStreams.size) && !evictStalestStream(Date.now())) {
        log(`⧉ stream ${sessionName}: refused — ${activeStreams.size}/${MAX_CONCURRENT_STREAMS} streams already active on this listener`);
        send(streamErrorFrame(sessionName, 'stream_limit'));
        return true;
    }
    let lastContent: string | null = null;
    // The cursor's last reported place, as `line,col`. Part of the diff-gate
    // because moving the cursor is a change the CAPTURE cannot show: an arrow
    // key inside a prompt leaves every character where it was, so gating on the
    // text alone means the mirror's cursor never moves — which is precisely the
    // feedback the cursor exists to give.
    let lastCursor: string | null = null;
    const stats: StreamStats = {
        startedAt: Date.now(),
        frames: 0,
        bytes: 0,
        framesBurst: 0,
        bytesBurst: 0,
        burstMs: 0,
        skipped: 0,
        rateCapped: 0,
        lastLogAt: Date.now(),
        lastLogFrames: 0,
        lastLogBytes: 0,
        lastLogFramesBurst: 0,
        lastLogBurstMs: 0,
    };
    // E2EE handshake: load-or-create this device's keypair up front. The
    // subscriber asked for encryption, so key failure is FAIL-CLOSED: refuse
    // to stream rather than downgrade to plaintext — a silent downgrade is
    // exactly the signal a key-stripping relay would produce. The phone sees
    // the error frame and can choose to re-subscribe without a key.
    const subscriberPublicKey = req.subscriberPublicKey;
    if (subscriberPublicKey) {
        initDeviceCrypto().catch((err) => {
            // Stream stopped or replaced while init was in flight — the
            // failure belongs to the old incarnation, not the current one.
            if (activeStreams.get(sessionName)?.stats !== stats) return;
            log(`⧉ stream ${sessionName}: device crypto init failed (${err instanceof Error ? err.message : err}) — refusing to stream (fail-closed)`);
            send(streamErrorFrame(sessionName, 'e2ee_unavailable'));
            stopStream(sessionName);
        });
    }
    let wireSeq = 0;
    let encryptFailures = 0;
    const budget: FrameBudget = { windowStartedAt: Date.now(), sent: 0 };
    /**
     * One capture. Returns false only when the stream is gone and the chain
     * must NOT re-arm — every other outcome re-arms at the single call site in
     * runTick, so no early return can silently freeze the mirror.
     */
    const captureTick = (entry: ActiveStream): boolean => {
        // Lease check rides the capture tick: one deadline field, no second
        // timer to leak. (The previous per-start expiry setTimeout was never
        // cleared on stop, so a restart left the old one armed to kill the new
        // incarnation.) Reaping here is what frees the slot for everyone whose
        // stop never arrived.
        if (Date.now() >= entry.expiresAt) {
            stopStream(sessionName);
            return false;
        }
        // capturePane is a blocking tmux spawn. Asking the budget first means a
        // second that is already full costs nothing rather than paying for a
        // capture whose frame could not go out — a peek, not a claim, so a tick
        // the diff-gate goes on to skip does not spend the token.
        if (!hasFrameBudget(budget, Date.now())) {
            stats.skipped++;
            stats.rateCapped++;
            return true;
        }
        const captured = capturePane(sessionName, true, STREAM_CAPTURE_LINES);
        if (!captured) {
            stats.skipped++;
            return true;
        }
        // Read per tick, not per sent frame: the gate below has to know whether
        // the cursor moved, and by the time a frame is being built the tick
        // that would have carried the move has already been skipped. One extra
        // tmux spawn on ticks that go on to send nothing is what that costs.
        const cursorAt = capturePaneCursor(sessionName);
        const cursor = cursorAt ? cursorLineFor(captured.content, cursorAt) : null;
        // Same read gives the pane height, which is what separates this frame's
        // scrollback from its visible rows — the offset a history pull starts at —
        // and the pane's total scrollback depth, which places that window in the
        // buffer for a viewer recording the lines that scroll past it.
        const historyLines = cursorAt
            ? historyLinesIn(captured.content, cursorAt.height)
            : undefined;
        const historySize = cursorAt?.historySize;
        const cursorKey = cursor ? `${cursor.line},${cursor.col}` : '';
        if (captured.content === lastContent && cursorKey === lastCursor) {
            stats.skipped++;
            return true; // diff-gate
        }
        const now = Date.now();
        // Send budget BEFORE the diff-gate is marked: a frame refused here has
        // to stay "changed" so a later tick retries it, or this content is
        // never sent at all — the next tick would diff-skip it as unchanged.
        if (!claimFrameSend(budget, now)) {
            stats.skipped++;
            stats.rateCapped++;
            return true;
        }
        // Phase = the gap that PRODUCED this tick (armedDelay), matching how
        // burstMs is charged in arm() — deciding by wall-clock here instead
        // made the last burst-armed frame count idle, under-reporting burst
        // fps by one frame per episode in the R2 numbers.
        const inBurst = armedDelay === BURST_INTERVAL_MS;
        lastContent = captured.content;
        lastCursor = cursorKey;
        // Stamp the sequence in CAPTURE order, synchronously — frame assembly
        // is async (encryption) and fire-and-forget, so resolve order is not
        // guaranteed under load; the receiver drops any seq it has already
        // painted past.
        const seq = ++wireSeq;
        void buildStreamFrame(captured, sessionName, subscriberPublicKey, { cursor, historyLines, historySize }).then((frame) => {
            // Stream stopped or restarted while this frame was in flight —
            // `stats` is unique per start, so it doubles as the identity
            // token. Don't send into a dead/replaced stream or skew its stats.
            if (activeStreams.get(sessionName)?.stats !== stats) return;
            if (!frame) {
                // Encrypt failure — frame dropped, diff-gate un-marked so the
                // next tick retries. A key that keeps failing (malformed
                // subscriber key) never recovers: fail closed after a few
                // strikes instead of retrying every tick for 5 minutes.
                lastContent = null;
                lastCursor = null;
                // Init still in flight (or failed — its own path fail-closes):
                // a not-yet-ready key is not a malformed key, don't strike.
                if (getDevicePublicKey() === null) return;
                encryptFailures++;
                if (encryptFailures >= STREAM_MAX_ENCRYPT_FAILURES) {
                    send(streamErrorFrame(sessionName, 'encrypt_failed'));
                    stopStream(sessionName);
                }
                return;
            }
            encryptFailures = 0;
            stats.frames++;
            // Measure the actual wire payload (the encrypted envelope is
            // ~1.4× the plaintext; base fields now count too, so plaintext
            // streams read slightly higher than the pre-E2EE content-only
            // metric) — this feeds the R2 cost instrumentation.
            const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf-8');
            stats.bytes += bytes;
            if (inBurst) {
                stats.framesBurst++;
                stats.bytesBurst += bytes;
            }
            // seq = capture order; epoch = this stream incarnation, so the
            // receiver's ordering guard resets across daemon-side restarts.
            send({ ...frame, seq, epoch: stats.startedAt });
            maybeLogStreamStats(sessionName, stats);
        }).catch((err) => {
            // A long-lived daemon must never crash on an unhandled rejection
            // from send()/logging — report and let the next tick carry on.
            log(`⧉ stream ${sessionName}: frame send failed (${err instanceof Error ? err.message : err})`);
        });
        return true;
    };
    /** Arm the next tick. A chain that outlived its incarnation (restart, or a
     *  stop racing this tick) must die here instead of capturing forever into
     *  a stream nobody can cancel — `stats` is the incarnation token. */
    let armedDelay = STREAM_INTERVAL_MS;
    const arm = (delay: number): void => {
        const entry = activeStreams.get(sessionName);
        if (entry?.stats !== stats) return;
        if (delay === BURST_INTERVAL_MS) stats.burstMs += delay;
        armedDelay = delay;
        const next = setTimeout(runTick, delay);
        next.unref?.();
        entry.timer = next;
    };
    const runTick = (): void => {
        const entry = activeStreams.get(sessionName);
        if (entry?.stats !== stats) return;
        if (!captureTick(entry)) return;
        // The cadence is re-read every tick, so input that lands mid-stream
        // tightens the NEXT gap rather than the current one.
        arm(streamCadence(entry.lastInputAt, Date.now()));
    };
    /** Swap an idle-armed tick for an immediate burst tick (see ActiveStream.wake).
     *  Only when the armed gap is the idle one: replacing an armed burst tick
     *  on every keystroke would push the next capture away indefinitely. */
    const wake = (): void => {
        const entry = activeStreams.get(sessionName);
        if (entry?.stats !== stats) return;
        if (armedDelay === BURST_INTERVAL_MS) return;
        clearTimeout(entry.timer);
        arm(BURST_INTERVAL_MS);
    };
    const timer = setTimeout(runTick, STREAM_INTERVAL_MS);
    timer.unref?.();
    // A renewing subscriber gets the short lease; anything older keeps the
    // 5-minute orphan guard so a version-skewed client isn't cut off mid-view.
    const renewing = !!req.renew;
    activeStreams.set(sessionName, {
        timer,
        stats,
        lastInputAt: null,
        inputDecryptFailures: 0,
        expiresAt: Date.now() + leaseFor(renewing),
        renewing,
        renewedAt: Date.now(),
        subscriberPublicKey,
        wake,
    });
    return true;
};

// ─── Ephemeral key input (agent.command.input) ───────────────────────
// Same end result as an `agent.command` push — keys or text into a tmux pane
// — but carried on the ephemeral relay instead of REST, which is one
// persisted hop shorter. Latency is the only reason it exists, so it must not
// buy that with a weaker posture: the tmux-side guards are the SAME code as
// the REST path (passesInjectGuards → shell-pane refusal + the one per-session
// token bucket, ALLOWED_KEYS via resolveKeys). A private counter here would
// double the effective 30/min cap.

/** Wire shape of one inbound injection. Every field is optional, and none of
 *  them is proven: this shape is an unchecked cast over relay JSON, so
 *  validateInputMessage re-checks the types it acts on rather than trusting
 *  the declaration. */
export interface AgentCommandInput {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    /** Which device's seq/epoch run this is. Current relays stamp it from the
     *  sending connection unconditionally; relays older than that overwrite
     *  only a missing value, so a sender there can claim another device's id.
     *  Treat it as an ordering namespace, never as authentication — the worst
     *  a forged id buys is a different reorder lane for its own keystrokes. */
    deviceId?: string;
    /** Named keys, ALLOWED_KEYS-validated. Mutually exclusive with `body`/`insert`. */
    keys?: string[];
    /** Literal text; the injector appends the Enter, as on the REST path. */
    body?: string;
    /**
     * Literal text delivered WITHOUT the submitting Enter — the phone
     * answering a y/n prompt, or typing half a command so a TUI menu opens.
     *
     * A separate field rather than a `submit: false` flag on `body`, and that
     * is the whole point: a daemon too old to know this field sees no `body`
     * either, so it injects nothing. The flag spelling would have had the old
     * daemon submit text the user never meant to send.
     */
    insert?: string;
    /** Sender's monotonic counter, and the incarnation it counts within. */
    seq?: number;
    epoch?: number;
    /** E2EE envelope sealing `{ keys | body }` plus a copy of the
     *  `sessionName`/`seq`/`epoch` stamp as JSON — the only way in on an
     *  encrypted stream, where `keys`/`body` above are refused. Present means
     *  the plaintext pair is ignored entirely: on a message the relay can
     *  append to, only the ciphertext decides what gets typed, and the sealed
     *  stamp is what proves the plaintext one was not re-written for a replay. */
    encrypted?: unknown;
}

/** Parity with the REST path, which refuses more than MAX_KEYS_PER_COMMAND per
 *  agent.command (zeph apps/server/src/functions/pushes.ts). The lower-latency
 *  door into the same pane must not also be the wider one. */
export const MAX_INPUT_KEYS = 10;
/** The REST path caps no body length, so this bound is ours alone: an
 *  unbounded body is one tmux send-keys argv of unbounded size, and what it
 *  lands in is an agent prompt, not a paste buffer. */
export const MAX_INPUT_BODY_CHARS = 4096;

/** The relay socket a message arrived on, and the only way back to its sender. */
type SendEphemeral = (data: Record<string, unknown>) => void;

/** One validated injection. */
type ValidatedInput = SequencedInput & {
    sessionName: string;
    /** Sender's device, when the relay stamped one — rides along so a refusal
     *  frame can name whose input was refused (inputDeviceId). */
    deviceId?: string;
    /** Exactly one of these is set. */
    tokens: string[] | null;
    text: string | null;
    /** Whether `text` carries its own submit. False for `insert` (and, vacuously,
     *  for a key batch — the keys say for themselves what they are). */
    submit: boolean;
};

/** A validated injection queued for delivery in seq order, carrying the socket
 *  it arrived on: the reorder hold outlives the call that accepted it, and a
 *  refusal at delivery time still has to reach the sender that is waiting. */
type PendingInput = ValidatedInput & { send: SendEphemeral };

type InputCheck = { ok: true; input: ValidatedInput } | { ok: false; reason: string };

// Both fields are relay JSON, so both are attacker-shaped. Number.isFinite
// admits 1e21 — which parks the high-water mark past anything a sender can
// count back to — and 1.5, which no later integer can ever equal, so every
// following key would sit out the hold before being typed out of order.
const isSeqNumber = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// A malformed `keys` would throw where it is consumed (resolveKeys iterates
// it, tmux args must be strings), and a throw inside the WebSocket message
// handler takes the whole daemon down. Type-check before acting.
const isKeyList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string');

/** Every field of an inbound envelope, all of them relay JSON. A missing or
 *  ill-typed one would reach WebCrypto as a string it cannot Base64-decode;
 *  refusing here keeps the failure a refusal rather than a thrown rejection. */
const isInputEnvelope = (v: unknown): v is EncryptedEphemeralPayload =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
    && (['ciphertext', 'iv', 'encryptedKey', 'keyIv', 'senderPublicKey'] as const)
        .every((field) => typeof (v as Record<string, unknown>)[field] === 'string');

/** The decrypted payload, under the same stance as the outer message: an
 *  unchecked cast that validateInputMessage re-checks field by field. Only the
 *  envelope's authenticity is proven at this point, never its contents —
 *  a subscriber can seal anything, including 400 keys. */
const parseSealedInput = (
    json: string,
): Pick<AgentCommandInput, 'keys' | 'body' | 'insert' | 'seq' | 'epoch' | 'sessionName'> | null => {
    try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        return parsed as Pick<AgentCommandInput, 'keys' | 'body' | 'insert' | 'seq' | 'epoch' | 'sessionName'>;
    } catch {
        return null;
    }
};

/**
 * Parse and whitelist an inbound input message. Pure — the lease gate and the
 * tmux-side guards stay in the caller, so this is testable on its own.
 */
export const validateInputMessage = (msg: AgentCommandInput): InputCheck => {
    const { sessionName, seq, epoch } = msg;
    if (typeof sessionName !== 'string' || !sessionName) return { ok: false, reason: 'no sessionName' };
    // This function reads plaintext `keys`/`body` and nothing else, so it must
    // never see a message that still carries an envelope: the encrypted path
    // opens one and hands the decrypted fields back through here with the
    // envelope stripped. A message arriving with both would otherwise get the
    // plaintext half injected while its sender believed the sealed half was
    // what landed. Fail closed instead.
    if (msg.encrypted !== undefined) return { ok: false, reason: 'envelope reached the plaintext validator' };
    if (!isSeqNumber(seq) || !isSeqNumber(epoch)) return { ok: false, reason: 'missing seq/epoch' };
    const base = {
        sessionName,
        seq,
        epoch,
        ...(typeof msg.deviceId === 'string' && msg.deviceId ? { deviceId: msg.deviceId } : {}),
    };
    if (msg.keys !== undefined) {
        if (!isKeyList(msg.keys)) return { ok: false, reason: 'malformed keys' };
        if (msg.keys.length > MAX_INPUT_KEYS) return { ok: false, reason: `too many keys (${msg.keys.length})` };
        if (msg.body !== undefined || msg.insert !== undefined) {
            return { ok: false, reason: 'keys are mutually exclusive with body/insert' };
        }
        const tokens = resolveKeys(msg.keys);
        if (!tokens) return { ok: false, reason: `unknown key(s) [${msg.keys.join(' ')}]` };
        return { ok: true, input: { ...base, tokens, text: null, submit: false } };
    }
    // Submitting and not-submitting the same text are opposite instructions,
    // so a message carrying both means nothing — refuse rather than pick one.
    if (msg.insert !== undefined) {
        if (msg.body !== undefined) return { ok: false, reason: 'insert and body are mutually exclusive' };
        if (typeof msg.insert !== 'string' || !msg.insert) return { ok: false, reason: 'empty input' };
        if (msg.insert.length > MAX_INPUT_BODY_CHARS) return { ok: false, reason: `insert too long (${msg.insert.length})` };
        return { ok: true, input: { ...base, tokens: null, text: msg.insert, submit: false } };
    }
    if (typeof msg.body !== 'string' || !msg.body) return { ok: false, reason: 'empty input' };
    if (msg.body.length > MAX_INPUT_BODY_CHARS) return { ok: false, reason: `body too long (${msg.body.length})` };
    return { ok: true, input: { ...base, tokens: null, text: msg.body, submit: true } };
};

/**
 * Type one ordered message into the pane. Unlike the REST key path this
 * schedules no follow-up snapshot: the message only got this far because a
 * live stream is already repainting the pane at frame rate.
 */
const deliverInput = (input: PendingInput): void => {
    // The reorder hold can outlive the lease that admitted the message.
    const injected = activeStreams.has(input.sessionName)
        && (input.tokens
            ? tryInjectKeys(input.sessionName, input.tokens, {})
            : tryInject(input.sessionName, input.text ?? '', {}, input.submit));
    // Every refusal reachable from here — dead lease, shell pane, rate limit,
    // a failed send-keys — used to be silent, which contradicts the contract
    // above: the sender would keep waiting on a keystroke that never lands
    // instead of falling back to the REST push path.
    if (!injected) input.send(streamErrorFrame(input.sessionName, 'input_rejected', input));
};

/** Ceiling on concurrent sender lanes. The lane key includes a relay-stamped
 *  deviceId, but a relay older than the unconditional stamp lets a sender vary
 *  it per message — without a cap that grows the map for the lease's whole
 *  life. Real senders are one per device; 16 is generous. */
export const MAX_INPUT_LANES = 16;

const inputSequencerFor = (key: string): InputSequencer<PendingInput> | null => {
    const existing = inputSequencers.get(key);
    if (existing) return existing;
    if (inputSequencers.size >= MAX_INPUT_LANES) return null;
    const created = createInputSequencer<PendingInput>(deliverInput, {
        // Held keys swept out by an epoch change or stream stop are keystrokes
        // their sender still waits on — refuse them so it can fall back.
        onDiscard: (input) => input.send(streamErrorFrame(input.sessionName, 'input_rejected', input)),
    });
    inputSequencers.set(key, created);
    return created;
};

/** Hand a validated injection to its sender's ordering lane. Shared by both
 *  inbound paths — plaintext and decrypted input order against each other. */
const enqueueInput = (input: ValidatedInput, send: SendEphemeral): void => {
    // One ordering run per sender, not per session: two devices typing into
    // the same pane each carry their own seq/epoch, and a shared sequencer
    // would let the higher epoch supersede the other and silence it.
    const senderKey = input.deviceId ? `${input.sessionName}#${input.deviceId}` : input.sessionName;
    const sequencer = inputSequencerFor(senderKey);
    if (!sequencer) return refuseInput(input, send, 'sender lane cap reached');
    const accepted = sequencer.accept({ ...input, send });
    if (accepted !== 'ok') {
        // overflow / superseded / stale — the message was dropped, and the
        // sender must hear so instead of waiting on a keystroke that never
        // lands (the sequencer reports swept HELD messages via onDiscard).
        refuseInput(input, send, accepted);
    }
};

/**
 * Tail of the encrypted-input decrypt chain.
 *
 * Encrypted inputs are opened one at a time rather than concurrently. That
 * bounds the ECDH work one socket can have in flight, and it keeps arrival
 * order into the sequencer — two keystrokes whose decrypts race would
 * otherwise reach it in whichever order WebCrypto finished, turning an
 * in-order pair into a gap and a 500 ms hold.
 */
let inputDecryptChain: Promise<void> = Promise.resolve();
let inputDecryptDepth = 0;

/** Ceiling on queued decrypts. The subscriber-key binding is a string compare
 *  against a public key the relay fanned out to every same-account connection,
 *  so it gates WHO can enqueue an ECDH derive, not how many — a flooding
 *  client would otherwise grow the chain without bound. Mirrors
 *  MAX_PENDING_INPUTS' role on the plaintext side. */
export const MAX_PENDING_DECRYPTS = 32;

/** Resolves once every encrypted input accepted so far has been routed. */
export const pendingInputDecrypts = (): Promise<void> => inputDecryptChain;

/**
 * Open an E2EE input envelope and route what was inside it.
 *
 * Every cheap guard runs synchronously, before any crypto: an envelope from
 * anyone but the subscriber costs a string compare, not an ECDH derive. What
 * comes out of the decrypt is then re-validated by exactly the checks the
 * plaintext path runs — the envelope hides the payload from the relay, never
 * from the whitelist or the caps.
 */
/**
 * Refuse one input message: log why here, tell the sender only THAT it was
 * refused. The reason is derived from plaintext the relay must not learn, so it
 * never rides the frame; a message with no sessionName gets no frame at all,
 * since the sender would have nothing to match it against.
 */
const refuseInput = (msg: AgentCommandInput, send: SendEphemeral, reason: string): void => {
    log(`! input ${msg.sessionName ?? '(no session)'}: ${reason} — drop`);
    if (typeof msg.sessionName === 'string' && msg.sessionName) {
        send(streamErrorFrame(msg.sessionName, 'input_rejected', msg));
    }
};

const handleEncryptedInput = (msg: AgentCommandInput, send: SendEphemeral): void => {
    const { sessionName } = msg;
    const refuse = (reason: string): void => refuseInput(msg, send, reason);
    if (typeof sessionName !== 'string' || !sessionName) return refuse('no sessionName');
    const stream = activeStreams.get(sessionName);
    if (!stream) return refuse('encrypted input with no live stream');
    // A stream that handshook no subscriber key has no key to bind this
    // envelope against — and its own frames go out in the clear, so there is
    // nothing here worth protecting and no way to prove who sent it.
    const { subscriberPublicKey } = stream;
    if (!subscriberPublicKey) return refuse('encrypted input on a plaintext stream');
    if (!isInputEnvelope(msg.encrypted)) return refuse('malformed encrypted envelope');
    // THE binding. Opening an envelope proves only that its sender holds some
    // private key; it is this comparison that makes it the key the subscriber
    // handshook with, and so makes ephemeral input exclusive to the device
    // actually watching the pane. Without it, anyone who learned this host's
    // public key could type into it.
    const envelope = msg.encrypted;
    if (envelope.senderPublicKey !== subscriberPublicKey) {
        return refuse('envelope not sealed by the stream subscriber');
    }
    // The incarnation this message was admitted under. A stream can stop and
    // restart — with a different subscriber key — while the decrypt is in
    // flight, and the lease check inside deliverInput only asks whether SOME
    // stream of this name exists.
    const incarnation = stream.stats;
    if (inputDecryptDepth >= MAX_PENDING_DECRYPTS) {
        return refuse('decrypt queue full');
    }
    // The binding compares against a public key the relay has seen, so it says
    // who MAY enqueue an ECDH derive, not that they can produce an openable
    // envelope. Sustained garbage would otherwise spend the one shared decrypt
    // chain on every stream at once. Same fail-closed shape as the outbound
    // half (STREAM_MAX_ENCRYPT_FAILURES): after a few consecutive failures this
    // stream takes no more sealed input until it is re-subscribed.
    if (stream.inputDecryptFailures >= STREAM_MAX_ENCRYPT_FAILURES) {
        return refuse('too many failed decrypts on this stream');
    }
    inputDecryptDepth++;
    inputDecryptChain = inputDecryptChain.then(async () => {
        inputDecryptDepth--;
        let opened: string;
        try {
            opened = await decryptEphemeral(envelope);
        } catch (err) {
            // AES-GCM is authenticated, so this is a forged, truncated or
            // misaddressed envelope — never a partially readable one.
            const live = activeStreams.get(sessionName);
            if (live?.stats === incarnation) live.inputDecryptFailures++;
            return refuse(`decrypt failed (${err instanceof Error ? err.message : err})`);
        }
        // A real envelope clears the strikes: the cap is there to stop a flood,
        // not to retire a stream that saw one corrupted message.
        const live = activeStreams.get(sessionName);
        if (live?.stats !== incarnation) {
            return refuse('stream replaced while decrypting');
        }
        live.inputDecryptFailures = 0;
        const payload = parseSealedInput(opened);
        if (!payload) return refuse('sealed payload is not an input object');
        // Replay binding: the ciphertext must vouch for the plaintext stamps.
        // AES-GCM stops the relay from forging content, but without this check
        // it could replay a captured envelope under a fresh seq and type a
        // real keystroke twice — the relay is exactly the party E2EE distrusts.
        if (payload.seq !== msg.seq || payload.epoch !== msg.epoch || payload.sessionName !== sessionName) {
            return refuse('sealed stamps do not match the plaintext ones (replay?)');
        }
        const checked = validateInputMessage({
            sessionName,
            seq: msg.seq,
            epoch: msg.epoch,
            deviceId: msg.deviceId,
            keys: payload.keys,
            body: payload.body,
            insert: payload.insert,
        });
        if (!checked.ok) return refuse(checked.reason);
        enqueueInput(checked.input, send);
    }).catch((err) => {
        // Nothing above should throw outside the decrypt, but one broken link
        // must not stall every keystroke queued behind it.
        log(`! input ${sessionName}: encrypted routing failed (${err instanceof Error ? err.message : err})`);
    });
};

/**
 * Handle agent.command.input. Returns true when the message was ours to
 * answer, so the caller stops routing it. Encrypted messages finish
 * asynchronously — the return value reports routing, not delivery, exactly as
 * it already did for a message the sequencer holds.
 */
export const handleCommandInput = (
    msg: AgentCommandInput,
    send: SendEphemeral,
): boolean => {
    if (msg.subtype !== 'agent.command.input') return false;
    // Addressing gate, as on stream control: the relay fans every ephemeral
    // message out to all of this user's connections, and two machines can run
    // the same tmux session name — an unaddressed inject would type into both.
    if (msg.targetDeviceId !== computeListenerDeviceId()) return false;
    // An envelope decides the message on its own. Branching here rather than
    // inside the validator is what keeps the plaintext `keys`/`body` a relay
    // could staple alongside it out of reach.
    if (msg.encrypted !== undefined) {
        handleEncryptedInput(msg, send);
        return true;
    }
    const checked = validateInputMessage(msg);
    if (!checked.ok) {
        refuseInput(msg, send, checked.reason);
        return true;
    }
    const { input } = checked;
    // Input rides the stream lease: without one, nobody is watching the pane
    // this would type into, and seq/epoch have no incarnation to order
    // against. The sender learns in one hop and falls back to a REST push.
    const stream = activeStreams.get(input.sessionName);
    if (!stream) {
        refuseInput(input, send, 'no live stream');
        return true;
    }
    // This stream's outbound half is E2EE for that subscriber, so accepting a
    // plaintext keystroke would leave the inbound leg the only one in clear —
    // and nothing about it proves the subscriber sent it. An encrypted stream
    // takes sealed input (above) or none.
    if (stream.subscriberPublicKey) {
        refuseInput(input, send, 'stream is E2EE, plaintext input refused');
        return true;
    }
    enqueueInput(input, send);
    return true;
};

export interface CollectResult {
    sessions: AgentSession[];
    /** Diagnostic notes per rejected session — surfaced under `--verbose`. */
    rejected: Array<{ name: string; reason: string }>;
}

/**
 * Inventory pass that also records *why* each `zeph-*` session was
 * skipped. The verbose log uses the rejection notes to explain empty
 * pickers (most common cause: tmux pane lost its start_command after a
 * re-attach, and the current command is `node` rather than `claude`).
 */
export const collectSessionsVerbose = (): CollectResult => {
    const list = spawnSync('tmux', tmuxArgs(['list-sessions', '-F',
        `#{session_name}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_created}${FIELD_SEP}#{session_activity}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (list.status !== 0) {
        const stderr = (list.stderr ?? '').toString().trim();
        log(`  tmux list-sessions failed: status=${list.status}${stderr ? ', stderr=' + stderr : ''}`);
        // Tmux call failed against the cached socket — the server it
        // pointed at is gone (died, restarted at a different path, etc).
        // Invalidate so the next cycle re-runs full discovery instead of
        // wedging the listener at "reported 0 session(s)" forever.
        invalidateTmuxSocketCache();
        return { sessions: [], rejected: [] };
    }

    const rawLines = (list.stdout ?? '').split('\n').filter(Boolean);
    // Sanity-check that the format separator actually survived. tmux is
    // supposed to pass non-format bytes through unchanged, but if any
    // shim (login shell, security tool, terminal wrapper) mangles the
    // 0x1f byte we'd parse the line as a single un-split field and drop
    // it as "not zeph-*". Detect that explicitly so the user isn't left
    // guessing.
    if (rawLines.length > 0 && !rawLines[0].includes(FIELD_SEP)) {
        log(`  tmux output missing FIELD_SEP — likely encoding issue. Raw line: ${JSON.stringify(rawLines[0])}`);
    }

    const sessions: AgentSession[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    // Pane cwd per session, read in the same sweep. Kept beside the wire shape
    // rather than in it: AgentSession is a server/phone contract and the
    // directory is local knowledge the registry needs, nothing the phone gets.
    const paneCwdOf = new Map<string, string>();
    for (const line of rawLines) {
        const [name, attached, created, activity] = line.split(FIELD_SEP);
        const parsed = parseSessionName(name);
        if (!parsed) {
            // Not noisy enough to log every plain tmux session here —
            // would clutter the verbose output on machines with many
            // non-zeph sessions.
            continue;
        }
        const info = readPaneInfo(name);
        const agent = detectRemoteAgent(info);
        if (!agent) {
            rejected.push({
                name,
                reason: `no agent in pane (start=${info.startCommand ?? 'null'}, current=${info.currentCommand ?? 'null'})`,
            });
            continue;
        }
        const agentSessionId = info.currentPath
            ? (agent.resolveSessionId?.(info.currentPath, info.panePid ?? undefined) ?? null)
            : null;
        const providerSessionName = info.currentPath
            ? (agent.resolveSessionName?.(info.currentPath, info.panePid ?? undefined) ?? null)
            : null;
        if (info.currentPath) paneCwdOf.set(name, info.currentPath);
        sessions.push({
            name,
            attached: attached === '1',
            agentKind: agent.kind,
            agentSessionId,
            project: parsed.project,
            label: parsed.label,
            providerSessionName,
            createdAt: epochToIso(created),
            lastActivityAt: epochToIso(activity),
            ...deriveSessionState(name, agent.kind, capturePaneText(name)),
        });
    }
    pruneSessionStates(new Set(sessions.map((s) => s.name)));
    // Write down what each live session IS, while it still exists to be read.
    // tmux forgets a session the moment it ends, which is exactly when the
    // phone wants it back — and a resume must take its directory and its binary
    // from what this machine observed, never from the wire.
    rememberSessions(
        sessions.map((s) => ({
            name: s.name,
            cwd: paneCwdOf.get(s.name) ?? null,
            agentKind: s.agentKind,
            project: s.project,
            label: s.label,
        })),
    );
    return { sessions, rejected };
};

/**
 * Snapshot the live `zeph-*` tmux sessions on this machine, enriched
 * with the running agent kind, the agent's own session id (when the
 * registry has a resolver — currently Claude Code only), project, and
 * tmux activity timestamps. Returns [] when tmux is unreachable or no
 * agent sessions exist. Sessions whose pane is at a shell or running
 * something not registered in remote-agents.ts are filtered out — the
 * phone can't usefully address them.
 */
const collectSessions = (): AgentSession[] => collectSessionsVerbose().sessions;

/** Names from the most recent inventory sweep; null until the first one lands —
 *  a membership check in that window (the connect burst) still sweeps in-thread. */
let inventorySnapshot: Set<string> | null = null;
let inThreadSweepLogged = false;
export const recordInventory = (sessions: ReadonlyArray<{ name: string }> | null): void => {
    inventorySnapshot = sessions && new Set(sessions.map((s) => s.name));
};
/** The daemon's sweep runner, set for the lifetime of `handleListener`. Null
 *  outside the daemon (tests, one-shot commands) — sweeps then run in-thread. */
let inventoryOffload: InventoryOffload | null = null;

/**
 * Mirror each session's provider name onto the tmux session itself, as the
 * user option `@zeph_agent_name`.
 *
 * Why: the phone shows what the agent calls this session (`zeph-to-d0`) while
 * the user's own status bar shows the tmux name (`zeph-zeph-to-3`), and the
 * two never agree. The phone's render precedence is already decided
 * (`alias ?? "<providerSessionName> · <Agent>" ?? computed label`, see the
 * `agentSessionAliases` comment in zeph `libs/shared/src/types/device.ts`);
 * this puts the same middle tier where a tmux config can read it:
 *
 *     #{?@zeph_agent_name,#{@zeph_agent_name},#S}
 *
 * A tmux option rather than a `#()` in the status line on purpose. The status
 * line re-renders per attached client on every status-interval, so a shell
 * there would walk a process tree several times a second across every session;
 * an option is written only when the name actually changes and costs the
 * renderer nothing.
 *
 * The tmux name is NOT renamed and must not be: it is the addressing key the
 * phone injects against, it has to exist before the agent it names does, and
 * the agent's own name rotates on resume. Display and address stay separate —
 * this only makes the display agree with the phone.
 *
 * Keyed by name AND `createdAt`, mirroring the alias anchor in zeph
 * `apps/server/src/lib/agent-session-alias.ts`: a tmux name is a slot, so the
 * cache must not let a new occupant inherit the previous one's write. tmux
 * drops session options with the session, so this is the belt to that braces —
 * what it actually prevents is the *skip*, where an unchanged key would leave
 * the new session with no write at all.
 */
const publishedTmuxNames = new Map<string, string>();

export const syncTmuxAgentNames = (sessions: ReadonlyArray<AgentSession>): void => {
    const liveKeys = new Set<string>();
    for (const s of sessions) {
        const key = `${s.name}\u241f${s.createdAt ?? ''}`;
        liveKeys.add(key);
        const value = s.providerSessionName ?? '';
        if (publishedTmuxNames.get(key) === value) continue;
        // No name to show → unset, so the format falls through to `#S` and no
        // stale value is left on a session whose agent stopped reporting one.
        const args = value
            ? ['set-option', '-t', s.name, '@zeph_agent_name', value]
            : ['set-option', '-u', '-t', s.name, '@zeph_agent_name'];
        const r = spawnSync('tmux', tmuxArgs(args), { stdio: ['ignore', 'ignore', 'ignore'] });
        // Only remember a write that landed; a failed one must be retried next
        // sweep rather than cached as done.
        if (r.status === 0) publishedTmuxNames.set(key, value);
    }
    for (const key of [...publishedTmuxNames.keys()]) {
        if (!liveKeys.has(key)) publishedTmuxNames.delete(key);
    }
};

/**
 * Is this session in the inventory? Answered from the last sweep when it can
 * be: a full sweep is two tmux spawns per session on this thread, and it used
 * to run again on every stream start and screen request (12% of daemon wall
 * time, measured 2026-08-26). A miss still sweeps, so a session
 * younger than one poll interval is not refused, and the inventory filter stays
 * the security boundary: only zeph-* panes running an agent are reachable.
 */
export const isInventoried = (sessionName: string): boolean => {
    if (inventorySnapshot?.has(sessionName)) return true;
    // Visible once, so a daemon that keeps sweeping in-thread can be seen doing it.
    if (inventorySnapshot && !inThreadSweepLogged) {
        inThreadSweepLogged = true;
        log(`inventory miss for ${sessionName} — swept in-thread (logged once)`);
    }
    return collectSessions().some((s) => s.name === sessionName);
};

// ─── Push handling ──────────────────────────────────────────────────

/**
 * One file riding on an `agent.command` push. agent.command attachments
 * are uploaded in *plaintext* (the listener has no per-user crypto key),
 * so `iv`/`encryptedKey` should be absent. If either is present the file
 * is encrypted and the listener can't read it — it gets skipped.
 */
interface PushFileAttachment {
    fileKey: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    iv?: string;
    encryptedKey?: string;
}

interface PushItem {
    pushId: string;
    type?: string;
    body?: string;
    title?: string;
    createdAt?: string;
    isEncrypted?: boolean;
    /** Set when type='agent.command' — tmux session name to inject into. */
    agentSessionName?: string;
    /** Named keys (Esc/arrows/Enter) to inject instead of body text —
     *  drives full-screen modals the phone can't escape with text. */
    keys?: string[];
    /** Literal text delivered WITHOUT the submitting Enter (see the same field
     *  on AgentCommandInput for why it is a field and not a flag). */
    insert?: string;
    /** Optional image/file attachments (agent.command only, plaintext). */
    files?: PushFileAttachment[];
}

interface HandlePushDeps {
    paneCommand?: (session: string) => string | null;
    inject?: (session: string, text: string) => boolean;
    /** Paste-only sibling of `inject` — text without the submitting Enter. */
    insertText?: (session: string, text: string) => boolean;
    sendKeys?: (session: string, tokens: string[]) => boolean;
    rateLimit?: (session: string, now?: number, cost?: number) => boolean;
    now?: () => number;
    /** Injectable for tests; defaults to the REST-backed downloader. */
    downloadAttachments?: (pushId: string, files: PushFileAttachment[]) => Promise<string[]>;
    /** Pane cwd lookup for the remote-origin marker (ADR-0002). */
    paneCwd?: (session: string) => string | null;
    /** Fired after a successful named-key injection so the WS loop can push
     *  fresh screen frames to the phone (scheduleInjectSnapshots). */
    onKeysInjected?: (session: string) => void;
}

/**
 * Shared inject path: pane guard → rate limit → tmux send-keys. Both
 * the structured `agent.command` push type and the legacy `@<session>`
 * prefix path route through here so the defense layers can't diverge.
 */
const passesInjectGuards = (session: string, deps: HandlePushDeps, cost = 1): boolean => {
    // Rate bucket first: the pane probe below is a blocking tmux spawnSync,
    // and the sequencer can flush several held messages back-to-back — an
    // empty bucket must refuse before paying that probe N times, not after.
    if (!(deps.rateLimit ?? checkRateLimit)(session, Date.now(), cost)) {
        log(`! ${session}: rate-limited — drop`);
        return false;
    }
    const cmd = (deps.paneCommand ?? paneCurrentCommand)(session);
    if (cmd === null) {
        log(`! ${session}: no such tmux session — drop`);
        return false;
    }
    if (isShellPane(cmd)) {
        log(`! ${session}: pane is at shell (${cmd}) — refusing (would be RCE)`);
        return false;
    }
    return true;
};

/**
 * Record a successful phone→pane text injection so a prompt-submit hook
 * (Claude Code plugin's zeph-remote.sh, or `zeph remote-hook` for
 * Gemini/Codex) can flag the matching prompt as remote-originated and
 * enter sticky REMOTE mode (ADR-0002). One file per project dir,
 * overwritten on every inject; the hook consumes it on an exact-text match.
 * Best-effort: a write failure must never fail the injection itself.
 */
export const writeRemoteMarker = (
    paneCwd: string,
    text: string,
    now: () => number = Date.now,
): boolean => {
    const hash = projectHash(paneCwd);
    if (!hash) return false;
    try {
        mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
        writeFileSync(remoteMarkerPath(hash), `${Math.floor(now() / 1000)} ${remoteDigest(text)}\n`);
        return true;
    } catch {
        return false;
    }
};

const defaultPaneCwd = (session: string): string | null => readPaneInfo(session).currentPath;

/**
 * Type text into a pane. `submit` false stops after the paste, leaving the
 * text in the prompt for the user to send themselves.
 *
 * The rate cost is `SUBMIT_COST` either way. An insert is not itself an
 * instruction, but it becomes one the moment the user presses Enter, and
 * charging it less would open a cheaper door into the same bucket.
 *
 * The remote-origin marker (ADR-0002) is written for an insert too: the hook
 * matches the submitted prompt against its digest, and after an insert the
 * submit is the user's own keypress. Text they edit before sending simply
 * fails the match and the marker expires, which is the best-effort contract
 * that path already has.
 */
const tryInject = (session: string, text: string, deps: HandlePushDeps, submit = true): boolean => {
    if (!text) {
        log(`! ${session}: empty text — drop`);
        return false;
    }
    if (!passesInjectGuards(session, deps, SUBMIT_COST)) return false;
    const ok = submit
        ? (deps.inject ?? injectKeys)(session, text)
        : (deps.insertText ?? pasteText)(session, text);
    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
    log(`${ok ? (submit ? '→' : '⇢') : '✗'} ${session}: ${preview}`);
    if (ok) {
        noteStreamInput(session);
        const cwd = (deps.paneCwd ?? defaultPaneCwd)(session);
        if (cwd) writeRemoteMarker(cwd, text);
    }
    return ok;
};

/** Key-event sibling of tryInject: same pane/shell/rate guards, but sends
 *  named keys instead of literal text + Enter. */
const tryInjectKeys = (session: string, tokens: string[], deps: HandlePushDeps): boolean => {
    if (!passesInjectGuards(session, deps)) return false;
    const ok = (deps.sendKeys ?? injectNamedKeys)(session, tokens);
    if (ok) noteStreamInput(session);
    log(`${ok ? '⌨' : '✗'} ${session}: [${tokens.join(' ')}]`);
    return ok;
};

// ─── Attachment download (agent.command files[]) ────────────────────

const ATTACHMENTS_DIR = join(homedir(), '.zeph', 'attachments');
const DEFAULT_API_BASE = 'https://api.zeph.to/v1';

// apiKey + baseUrl for the file-download REST calls, set once in
// handleListener. The default downloader reads it. null until the daemon
// resolves credentials (handlePush isn't called before then in the real
// flow, but the guard keeps it safe).
let attachmentCtx: { apiKey: string; baseUrl: string } | null = null;

export const setAttachmentContext = (ctx: { apiKey: string; baseUrl: string }): void => {
    attachmentCtx = ctx;
};

/**
 * Make a filesystem-safe single path segment: take the basename (drops
 * any `../` prefix), strip control chars and embedded separators, remove
 * leading dots, and cap length. Empty/dot-only names use the fallback.
 */
const safeSegment = (raw: string, fallback: string): string => {
    const cleaned = basename(raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[/\\]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return (cleaned || fallback).slice(0, 200);
};

/** Resolve fileKey → presigned URL → bytes. Throws on any HTTP failure so
 *  the caller can isolate one file's failure from the rest of the batch. */
const fetchAttachmentBytes = async (
    fileKey: string,
    ctx: { apiKey: string; baseUrl: string },
): Promise<Buffer> => {
    const metaUrl = `${ctx.baseUrl.replace(/\/+$/, '')}/files/${encodeURIComponent(fileKey)}`;
    const meta = await fetch(metaUrl, { headers: { 'X-API-Key': ctx.apiKey } });
    if (!meta.ok) throw new Error(`metadata ${meta.status}`);
    // Server wraps responses as { data: { downloadUrl } } (see lib/response ok()).
    const body = (await meta.json()) as { data?: { downloadUrl?: string }; downloadUrl?: string };
    const downloadUrl = body.data?.downloadUrl ?? body.downloadUrl;
    if (!downloadUrl) throw new Error('response had no downloadUrl');
    // The presigned URL is self-authenticating — no API key header.
    const bin = await fetch(downloadUrl);
    if (!bin.ok) throw new Error(`download ${bin.status}`);
    return Buffer.from(await bin.arrayBuffer());
};

/**
 * Download every plaintext attachment to
 * `~/.zeph/attachments/<pushId>/<fileName>` and return absolute paths.
 * Encrypted files are skipped (no key). A single file's failure is logged
 * and skipped — it never aborts the batch, so a partial download still
 * injects whatever succeeded. Files are kept (not deleted) so the agent
 * can read them after injection.
 */
const downloadAttachments = async (
    pushId: string,
    files: PushFileAttachment[],
    ctx: { apiKey: string; baseUrl: string },
): Promise<string[]> => {
    const dir = join(ATTACHMENTS_DIR, safeSegment(pushId, 'push'));
    const paths: string[] = [];
    for (const [i, f] of files.entries()) {
        if (f.iv || f.encryptedKey) {
            log(`! attachment "${f.fileName}": encrypted (iv/encryptedKey present) — listener can't decrypt, skipping`);
            continue;
        }
        try {
            const bytes = await fetchAttachmentBytes(f.fileKey, ctx);
            mkdirSync(dir, { recursive: true });
            const abs = join(dir, safeSegment(f.fileName || `file-${i}`, `file-${i}`));
            writeFileSync(abs, bytes);
            paths.push(abs);
            log(`⇣ ${f.fileName} → ${abs} (${bytes.length}B)`);
        } catch (err) {
            log(`! attachment "${f.fileName}": download failed — ${(err as Error).message}`);
        }
    }
    return paths;
};

const defaultDownloadAttachments = (pushId: string, files: PushFileAttachment[]): Promise<string[]> => {
    if (!attachmentCtx) {
        log('! attachment context not initialised — skipping files');
        return Promise.resolve([]);
    }
    return downloadAttachments(pushId, files, attachmentCtx);
};

/**
 * Combine the command body with downloaded file paths, one per line.
 * Claude Code reads local image paths from the prompt text, so appending
 * absolute paths makes the agent load them. Empty body → paths only.
 */
const composeInjection = (body: string, paths: string[]): string =>
    paths.length ? [body, ...paths].filter(Boolean).join('\n') : body;

// Downloaded attachments are kept after injection (the agent reads them
// from disk), so they accumulate. A per-push dir older than this is GC'd —
// long enough to outlive any realistic agent read, short enough that the
// directory can't grow without bound on a long-running daemon.
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Remove attachment sub-directories whose mtime is older than `ttl`.
 * Best-effort: an entry that can't be statted or removed is skipped, not
 * fatal. Returns the count removed. `dir`/`ttl` are injectable for tests.
 */
export const gcAttachments = (
    now: number = Date.now(),
    dir: string = ATTACHMENTS_DIR,
    ttl: number = ATTACHMENT_TTL_MS,
): number => {
    let removed = 0;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return 0; }
    for (const name of entries) {
        const full = join(dir, name);
        try {
            if (now - statSync(full).mtimeMs <= ttl) continue;
            rmSync(full, { recursive: true, force: true });
            removed++;
        } catch { /* skip unreadable/unremovable entries */ }
    }
    return removed;
};

/**
 * Process one push. Returns true when an injection actually fired.
 * Exported for unit testing with mocked deps.
 *
 * Only acts on `type='agent.command'` pushes carrying both an
 * `agentSessionName` (tmux session to inject into) and a non-empty
 * `body`. Everything else (Stop-hook auto-pushes, zeph_ask responses,
 * encrypted pushes, normal text/link/file notifications) is ignored.
 */
export const handlePush = async (
    push: PushItem,
    deps: HandlePushDeps = {},
): Promise<boolean> => {
    if (push.isEncrypted) {
        // Per-device keys aren't wired yet; encrypted pushes are opaque
        // to the listener.
        return false;
    }
    if (push.type !== 'agent.command' || !push.agentSessionName) return false;

    // Key event (Esc / arrows / Enter) — no body, no attachments. Lets the
    // phone escape a full-screen modal (e.g. after `/usage`) that swallows
    // text input.
    if (push.keys?.length) {
        const tokens = resolveKeys(push.keys);
        if (!tokens) {
            log(`! ${push.agentSessionName}: unknown key(s) [${push.keys.join(' ')}] — drop`);
            return false;
        }
        const injected = tryInjectKeys(push.agentSessionName, tokens, deps);
        if (injected) deps.onKeysInjected?.(push.agentSessionName);
        return injected;
    }

    // Text without the submit — the phone answering a y/n prompt, or typing
    // half a command so a TUI menu opens. No attachments: an insert is a
    // partial line the user is still editing, and file paths appended to it on
    // their own rows would be in the way rather than useful.
    if (push.insert !== undefined) {
        if (push.body) {
            log(`! ${push.agentSessionName}: insert and body are mutually exclusive — drop`);
            return false;
        }
        return tryInject(push.agentSessionName, push.insert, deps, false);
    }

    // Download any attachments BEFORE injecting so the agent can read the
    // local paths immediately. A download-phase failure is isolated: the
    // body text still injects so the command itself isn't blocked.
    let paths: string[] = [];
    if (push.files?.length) {
        const download = deps.downloadAttachments ?? defaultDownloadAttachments;
        try {
            paths = await download(push.pushId, push.files);
        } catch (err) {
            log(`! ${push.agentSessionName}: attachment download failed — ${(err as Error).message}`);
        }
    }

    return tryInject(push.agentSessionName, composeInjection(push.body ?? '', paths), deps);
};

// ─── WS connect loop ─────────────────────────────────────────────────

const verifyTmux = (): void => {
    const r = spawnSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) {
        console.error('zeph listener: tmux not found on PATH. Install tmux first.');
        process.exit(127);
    }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const computeBackoff = (attempt: number): number => {
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    const jitter = base * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    return Math.max(0, base + jitter);
};

interface SessionResult {
    /** Resolved with the close code if the server closed cleanly. */
    closeCode: number | null;
    /** Resolved with reason text for logging. */
    reason: string;
    /** True if the socket ever reached `open` — resets reconnect backoff. */
    connected: boolean;
}

/**
 * Stable per-host device id for the listener. We hash the OS hostname so
 * the same machine reuses the same DeviceRecord across listener restarts
 * (otherwise the phone's session inventory grows a new ghost device every
 * time `zeph listener` rebinds). `dev_listener_<sha8(hostname)>` keeps it
 * human-recognisable in dev logs without leaking the raw hostname.
 *
 * The no-arg result must identify the MACHINE, stably:
 * - NOT the hostname: macOS rewrites it on network changes (observed
 *   flip-flopping between 'Mac' and '<name>.local' within hours), which
 *   split one machine into several device rows — duplicated session lists
 *   on the phone, and screen-peek requests addressed to an id no live
 *   process answers for.
 * - NOT a file under ~/.zeph alone: users copy ~/.zeph to a new machine
 *   to carry their API key, and a copied id makes two machines answer for
 *   each other.
 * So: hash the platform machine id (IOPlatformUUID / /etc/machine-id) —
 * deterministic per machine, immune to both. The sticky file is only the
 * fallback for platforms where no machine id is readable.
 */
let processListenerDeviceId: string | undefined;

const LISTENER_ID_FILE = join(homedir(), '.zeph', 'listener-device-id');

const hashListenerId = (seed: string): string =>
    `dev_listener_${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;

const readMachineId = (): string | null => {
    try {
        if (process.platform === 'darwin') {
            const r = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const m = r.stdout?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (m) return m[1];
        }
        if (process.platform === 'linux') {
            for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                try {
                    const v = readFileSync(p, 'utf-8').trim();
                    if (v) return v;
                } catch { /* try next */ }
            }
        }
    } catch { /* fall through to the sticky-file fallback */ }
    return null;
};

export const computeListenerDeviceId = (host?: string): string => {
    if (host !== undefined) return hashListenerId(host);
    if (processListenerDeviceId) return processListenerDeviceId;

    const machineId = readMachineId();
    if (machineId) {
        processListenerDeviceId = hashListenerId(machineId);
        return processListenerDeviceId;
    }

    // No readable machine id — pin the first hostname-derived id to a file
    // so at least hostname drift can't split this machine.
    try {
        const saved = readFileSync(LISTENER_ID_FILE, 'utf-8').trim();
        if (/^dev_listener_[0-9a-f]{8}$/.test(saved)) {
            processListenerDeviceId = saved;
            return saved;
        }
    } catch { /* first run — fall through to compute + persist */ }

    const fresh = hashListenerId(hostname());
    try {
        mkdirSync(join(homedir(), '.zeph'), { recursive: true });
        writeFileSync(LISTENER_ID_FILE, fresh);
    } catch { /* persistence is best-effort; in-memory pin still holds */ }
    processListenerDeviceId = fresh;
    return fresh;
};

interface StreamHandle {
    done: Promise<SessionResult>;
    terminate: () => void;
}

/**
 * Open one WebSocket and stream messages until it closes. `done` resolves
 * when the connection is gone; the outer loop decides whether to reconnect.
 * `terminate` lets a signal handler force-close from outside (otherwise
 * SIGINT during an open WS would hang the loop until the server closed).
 */
const streamSession = (wsUrl: string, apiKey: string): StreamHandle => {
    let ws: WebSocket | null = null;
    let opened = false;
    const done = new Promise<SessionResult>((resolve) => {
        // deviceId + listenerNickname let the backend attach the connection
        // to a DeviceRecord (auto-created on first connect for apiKey auth).
        // Without these the `listener.sessions` reports are silently dropped
        // server-side and the phone's picker stays empty.
        // KNOWN TRADEOFF: apiKey rides the query string, so it can land in
        // API Gateway access logs. The $connect route can't read custom
        // headers from every WS client; moving to first-message auth needs a
        // server-side change (tracked upstream).
        const deviceId = computeListenerDeviceId();
        const nickname = hostname() || 'listener';
        const params = new URLSearchParams({
            apiKey,
            deviceId,
            listenerNickname: nickname,
        });
        const url = `${wsUrl}?${params.toString()}`;
        ws = new WebSocket(url);
        const sock = ws;

        let pingTimer: NodeJS.Timeout | null = null;
        let pongTimer: NodeJS.Timeout | null = null;
        let sessionsTimer: NodeJS.Timeout | null = null;
        let connectTimer: NodeJS.Timeout | null = null;
        let stallTimer: NodeJS.Timeout | null = null;
        // Updated on every server-acked round-trip (ack / pong). The
        // stall watchdog terminates the WS if this stays stale too long,
        // which lets the reconnect loop recover from half-open sockets
        // (suspended laptop, NAT drop, server unreachable but TCP alive).
        let lastRoundTripAt = Date.now();

        const cleanup = (): void => {
            if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        };

        // If the WS doesn't reach OPEN within the timeout, kill it.
        // Otherwise an unreachable backend (DNS / route / SG drop) keeps
        // the socket in CONNECTING forever and `done` never resolves.
        connectTimer = setTimeout(() => {
            if (sock.readyState !== WebSocket.OPEN) {
                log(`! connect timeout after ${WS_CONNECT_TIMEOUT_MS / 1000}s — terminating`);
                sock.terminate();
            }
        }, WS_CONNECT_TIMEOUT_MS);

        // Report gate state — per connection on purpose: a fresh socket
        // must always send its first inventory (the server may have
        // nothing, or another listener's stale data, for this device).
        let lastSentFingerprint: string | null = null;
        let lastSentAtMs = 0;

        let sweepInFlight = false;
        const reportSessions = async (): Promise<void> => {
            if (sock.readyState !== WebSocket.OPEN) return;
            // One sweep at a time: a slow sweep must not stack a second behind it.
            if (sweepInFlight) return;
            sweepInFlight = true;
            try {
                const inventory = inventoryOffload ? await inventoryOffload.collect() : collectSessionsVerbose();
                if (sock.readyState === WebSocket.OPEN) publishSessions(inventory);
            } catch (err) {
                log(`! session sweep failed, skipping this cycle: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                sweepInFlight = false;
            }
        };
        const publishSessions = ({ sessions, rejected }: CollectResult): void => {
            recordInventory(sessions);
            // Let the user's own status bar say what the phone says. Change-gated
            // internally, so an unchanged sweep spawns nothing.
            syncTmuxAgentNames(sessions);
            // Watch hits are one-shot events — they go out on every poll,
            // independent of the sessions-report gate below.
            // (§S5 v2): probe watched panes and report hits; the server
            // consumes the record and the next ack prunes it locally.
            for (const hit of collectWatchHits(new Set(sessions.map((s) => s.name)))) {
                sock.send(JSON.stringify({ type: 'listener.watch.hit', data: hit }));
                log(`🔔 watch hit: ${hit.sessionName} ~ /${hit.pattern}/`);
            }
            // Unchanged inventory + heartbeat not due → skip the send.
            // The 5 s local poll above still ran, so a change is never
            // delayed; only the no-op reports (idle listener) are culled.
            // Past sessions ride the report that already exists rather than a
            // request of their own: the phone is already reading this device
            // record, and a second round trip would need its own timeout, its
            // own failure wording and its own staleness question.
            const known = knownSessionsToReport(sessions);
            const fingerprint =
                `${sessionsFingerprint(sessions)}␞${knownSessionsFingerprint(known)}`;
            if (!sessionsReportDue(fingerprint, lastSentFingerprint, lastSentAtMs, Date.now())) {
                return;
            }
            sock.send(
                JSON.stringify({ type: 'listener.sessions', data: { sessions, knownSessions: known } }),
            );
            lastSentFingerprint = fingerprint;
            lastSentAtMs = Date.now();
            // One line per send gives the user immediate feedback on
            // what the phone picker will see — particularly important
            // during setup, when an empty picker has no other observable
            // cause. (Skipped cycles stay quiet — same signal, less noise.)
            const names = sessions
                .map((s) => (s.state ? `${s.name}[${s.state}]` : s.name))
                .join(', ') || '∅';
            log(`reported ${sessions.length} session(s): ${names}`);
            // Explain skipped zeph-* sessions so the most common
            // confusion (pane lost its claude start_command after a
            // re-attach) shows up directly in the log.
            for (const r of rejected) log(`  skip ${r.name}: ${r.reason}`);
            // When the parsed result is empty AND nothing was rejected,
            // we likely have a tmux-visibility issue (different socket,
            // tmux server not running, etc.). Dump what tmux sees from
            // *this process's* perspective so the user can compare with
            // their interactive shell.
            if (sessions.length === 0 && rejected.length === 0) {
                const raw = spawnSync('tmux', tmuxArgs(['list-sessions', '-F', '#{session_name}']), {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                if (raw.status !== 0) {
                    const err = (raw.stderr ?? '').toString().trim() || 'no stderr';
                    log(`  diag: tmux list-sessions exit=${raw.status}, ${err}`);
                } else {
                    const all = (raw.stdout ?? '').trim().split('\n').filter(Boolean);
                    log(`  diag: tmux sees ${all.length} session(s) total: ${all.join(', ') || '∅'}`);
                    if (all.length > 0) {
                        log(`  diag: none start with "zeph-" — check wrapper output or run 'zeph cc' to verify naming`);
                    }
                }
            }
        };

        sock.on('open', () => {
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            opened = true;
            lastRoundTripAt = Date.now();
            log('connected');
            // Initial inventory so the phone's picker has something to
            // show as soon as the listener comes online.
            void reportSessions();
            sessionsTimer = setInterval(() => void reportSessions(), SESSION_REPORT_INTERVAL_MS);

            pingTimer = setInterval(() => {
                if (sock.readyState !== WebSocket.OPEN) return;
                sock.send(JSON.stringify({ type: 'ping' }));
                pongTimer = setTimeout(() => {
                    log('! pong timeout — forcing reconnect');
                    sock.terminate();
                }, PONG_TIMEOUT_MS);
            }, PING_INTERVAL_MS);

            // Independent stall watchdog. If we go > WS_STALL_TIMEOUT_MS
            // without any server message landing — ack, pong, anything —
            // the socket is effectively half-open. ping/pong should catch
            // most of this but a sleeping laptop can pause the JS timer
            // such that pongTimer is checked AFTER the suspension and
            // appears 'recently scheduled'. The watchdog uses wall-clock
            // delta vs lastRoundTripAt so it's resilient to that.
            stallTimer = setInterval(() => {
                if (sock.readyState !== WebSocket.OPEN) return;
                if (Date.now() - lastRoundTripAt > WS_STALL_TIMEOUT_MS) {
                    log(`! no server traffic for ${Math.round((Date.now() - lastRoundTripAt) / 1000)}s — terminating`);
                    sock.terminate();
                }
            }, 15_000);
        });

        sock.on('message', (raw) => {
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            lastRoundTripAt = Date.now();
            let msg: unknown;
            try {
                msg = JSON.parse(raw.toString('utf-8'));
            } catch {
                return; // malformed — ignore
            }
            if (!msg || typeof msg !== 'object') return;
            const m = msg as { type?: string; data?: unknown; message?: string };
            if (m.type === 'pong') return;
            if (m.type === 'push.new' && m.data) {
                // Fire-and-forget: handlePush is async (attachment download)
                // but the WS read loop must stay responsive. Errors are
                // logged, never thrown into the socket handler.
                void handlePush(m.data as PushItem, {
                    onKeysInjected: (session) =>
                        scheduleInjectSnapshots(session, (data) => {
                            if (sock.readyState === WebSocket.OPEN) {
                                sock.send(JSON.stringify({ type: 'ephemeral', data }));
                            }
                        }),
                }).catch((err) =>
                    log(`! handlePush: ${(err as Error).message}`));
            }
            if (m.type === 'ephemeral' && m.data) {
                // Screen peek (§S4): the phone asks for this machine's live
                // pane content over the ephemeral relay; the reply rides the
                // same channel. Nothing is persisted server-side.
                const sendEphemeral = (data: object) => {
                    if (sock.readyState === WebSocket.OPEN) {
                        sock.send(JSON.stringify({ type: 'ephemeral', data }));
                    }
                };
                // Live mirror (PoC): agent.stream.start/stop drives a
                // continuous, diff-gated frame loop; falls through to the
                // one-shot screen-peek when it isn't a stream-control message.
                // agent.command.input types into a streamed pane without the
                // REST round-trip; it is only accepted while that stream's
                // lease is live, so it sits behind the same routing chain.
                if (
                    !handleCommandInput(m.data as AgentCommandInput, sendEphemeral) &&
                    !handleStreamControl(m.data as StreamControl, sendEphemeral) &&
                    // A page of scrollback answers through `send` rather than by
                    // return value: on an encrypted stream it finishes after the
                    // seal, exactly like the frames it is history for.
                    !handleScreenHistoryRequest(m.data as ScreenHistoryRequest, sendEphemeral)
                    // Resume creates a process rather than typing into one, so
                    // it takes nothing from the wire but a session name — the
                    // rest comes from what this machine wrote down itself.
                    && !handleSessionResumeRequest(m.data as SessionResumeRequest, sendEphemeral)
                    && !handleSessionExitRequest(m.data as SessionExitRequest, sendEphemeral)
                    // Forget is the same envelope pointed the other way: it
                    // takes a name out of the record resume reads from.
                    && !handleSessionForgetRequest(m.data as SessionForgetRequest, sendEphemeral)
                    // Reading the session's changes: read-only git in the repo
                    // the registry recorded, never a path or command from here.
                    && !handleDiffFilesRequest(m.data as DiffFilesRequest, sendEphemeral)
                    && !handleDiffFileRequest(m.data as DiffFileRequest, sendEphemeral)
                ) {
                    const reply = handleScreenRequest(m.data as ScreenRequest);
                    if (reply) sendEphemeral(reply);
                }
            }
            // Surface server-side errors from listener.sessions reports.
            // Without this the daemon happily logs "reported N session(s)"
            // even when the server is silently dropping every message —
            // exactly how the picker-empty bug stayed hidden for weeks.
            if (m.type === 'listener.sessions.error') {
                log(`! server rejected listener.sessions: ${m.message ?? '(no detail)'}`);
            }
            if (m.type === 'listener.sessions.ack') {
                const d = m.data as { count?: number; updatedAt?: string; watches?: unknown } | undefined;
                log(`✓ server persisted ${d?.count ?? '?'} session(s)`);
                // Pattern watches ride the ack (§S5 v2) — refresh ours.
                setPatternWatches(d?.watches);
            }
            // `push.sync` (offline batch on $connect) and other types ignored.
        });

        sock.on('error', (err) => {
            log(`! ws error: ${err.message}`);
        });

        sock.on('close', (code, reasonBuf) => {
            stopAllStreams();
            cleanup();
            resolve({ closeCode: code, reason: reasonBuf?.toString('utf-8') ?? '', connected: opened });
        });
    });

    return {
        done,
        terminate: () => { ws?.terminate(); },
    };
};

const DEFAULT_WS_URL = 'wss://ws.zeph.to';

/**
 * A user who only set ZEPH_API_KEY (no `zeph login`, no config file) gets the
 * prod socket by default — mirroring the DEFAULT_API_BASE fallback for REST.
 * The default only applies when the base URL is also the prod default: with a
 * custom base URL, silently pointing the listener at the prod socket while
 * REST talks to another stage would split the device across environments, so
 * that combination still errors loudly.
 */
export const resolveWsUrl = (
    args: Record<string, string | boolean>,
    config: { wsUrl?: string },
    baseUrl: string,
): string | null => {
    const fromArg = typeof args['ws-url'] === 'string' ? (args['ws-url'] as string) : null;
    return fromArg || resolvedEnv('ZEPH_WS_URL') || config.wsUrl
        || (baseUrl === DEFAULT_API_BASE ? DEFAULT_WS_URL : null);
};

// ── Singleton guard (PID file) ──────────────────────────────────────

/**
 * Whether another `zeph listener` is already running on this machine.
 * The wrapper's autostart and a user typing `zeph listener` by hand can
 * race — both check this guard so we don't spawn duplicates that
 * compete for the same `agent.command` pushes.
 *
 * Stale PID files (process gone) are treated as "no listener" so the
 * wrapper can recover from crashes without manual cleanup.
 */
const otherListenerAlive = (): number | null => {
    const pid = runningListenerPid();
    return pid === null || pid === process.pid ? null : pid;
};

const writeListenerPid = (): void => {
    try {
        // Stamp the version alongside the pid: `npm i -g` swaps the package
        // on disk without touching this already-running process, and the
        // stamp is how `zeph cc` notices the drift and restarts us.
        writeListenerRuntime(VERSION);
    } catch (err) {
        log(`! could not write ${LISTENER_PID_FILE}: ${(err as Error).message}`);
    }
};

const removeListenerPid = (): void => clearListenerRuntime(process.pid);

/**
 * `--stop` / `--restart`: the daemon is a background service, so the only
 * way to replace a stale one used to be hunting its pid by hand. `--restart`
 * relaunches detached (not in the caller's foreground) because restarting is
 * an ops action — the user wants their shell back, not a new daemon pinned
 * to it.
 */
const handleListenerLifecycle = async (restart: boolean): Promise<number> => {
    // launchd owns the process when the login-time service is installed:
    // signalling the pid ourselves would have launchd start a replacement
    // behind our back. `bootout` and not `disable` — see listener-service.ts.
    if (serviceInstalled()) {
        const result = restart ? restartService() : stopService();
        if (!result.ok) {
            console.error(`zeph listener: ${result.reason}`);
            return 1;
        }
        for (const note of result.notes) console.log(`zeph listener: ${note}`);
        return 0;
    }

    const pid = otherListenerAlive();
    if (pid) {
        const stopped = await stopListener(pid);
        console.log(`zeph listener: stopped pid ${pid}${stopped ? '' : ' (forced)'}`);
    } else {
        console.log('zeph listener: no listener running');
        // A pid file left behind by a crashed daemon would otherwise keep
        // tripping the singleton guard on the next start.
        clearStaleListenerRuntime();
    }
    if (!restart) return 0;
    if (!spawnListenerDetached()) {
        console.error('zeph listener: could not resolve the cli entry to respawn — run `zeph listener` manually.');
        return 1;
    }
    console.log(`zeph listener: restarted in background (log: ${LISTENER_LOG_FILE})`);
    return 0;
};

/**
 * `--install-service` / `--uninstall-service` / `--service-status`: the
 * LaunchAgent that starts this daemon at login. Runs before verifyTmux for the
 * same reason the lifecycle flags do — reporting or removing a service must not
 * need a healthy tmux (and installing does its own, better, tmux check).
 */
const handleServiceFlags = async (args: Record<string, string | boolean>): Promise<number> => {
    const say = (notes: readonly string[]): void => {
        for (const note of notes) console.log(`  ${note}`);
    };

    if (args['install-service'] === true) {
        const result = await installService();
        say(result.notes);
        if (!result.ok) {
            console.error(`zeph listener: ${result.reason}`);
            return 1;
        }
        console.log(`zeph listener: ${SERVICE_LABEL} installed — the listener now starts at every login.`);
        return 0;
    }

    if (args['uninstall-service'] === true) {
        const result = await uninstallService();
        say(result.notes);
        if (!result.ok) {
            console.error(`zeph listener: ${result.reason}`);
            return 1;
        }
        console.log('zeph listener: login-time service removed. `zeph cc` still autostarts the daemon.');
        return 0;
    }

    const status = serviceStatus();
    if (!status.supported) {
        console.log('zeph listener: login-time service is macOS-only (launchd).');
        return 0;
    }
    if (!status.installed) {
        console.log('zeph listener: no login-time service — run `zeph listener --install-service`.');
        return 0;
    }
    console.log(`zeph listener: ${status.label} installed`);
    console.log(`  plist: ${status.plistPath}`);
    console.log(`  node:  ${status.nodePath ?? '(unreadable)'}`);
    console.log(`  cli:   ${status.cliPath ?? '(unreadable)'}`);
    console.log(`  PATH:  ${status.pathEnv ?? '(unreadable)'}`);
    if (status.missing.length > 0) {
        console.error(`  ! missing: ${status.missing.join(', ')} — re-run \`zeph listener --install-service\``);
        return 1;
    }
    return 0;
};

export const handleListener = async (args: Record<string, string | boolean>): Promise<number> => {
    // Service flags first: they neither need nor start a daemon in this process.
    if (args['install-service'] === true || args['uninstall-service'] === true || args['service-status'] === true) {
        return handleServiceFlags(args);
    }

    // Lifecycle flags run before verifyTmux — stopping a daemon shouldn't
    // require a healthy tmux.
    if (args.stop === true || args.restart === true) return handleListenerLifecycle(args.restart === true);

    verifyTmux();

    // Refuse to start when another listener is already running. The
    // wrapper's autostart calls us blindly on every `zeph cc`; the user
    // running `zeph listener` directly does too. Bail with exit 0 (not
    // an error — there *is* a listener, just not us).
    const otherPid = otherListenerAlive();
    if (otherPid) {
        if (process.env.ZEPH_LISTENER_AUTOSTART === '1') {
            // Autostart from the wrapper — stay quiet on the happy path.
            return 0;
        }
        console.error(`zeph listener: another listener is already running (pid ${otherPid}). ` +
            `Tail \`~/.zeph/listener.log\` to follow it, or kill ${otherPid} first.`);
        return 0;
    }

    const config = loadConfig();
    const apiKey = (args.key as string) || resolvedEnv('ZEPH_API_KEY') || config.apiKey;
    if (!apiKey) {
        console.error('zeph listener: API key required. Run `zeph install` or set ZEPH_API_KEY.');
        return 3;
    }
    // Base URL for attachment downloads (GET /v1/files/{fileKey}). Same
    // resolution order as the rest of the CLI; falls back to the prod API.
    const baseUrl = (args['base-url'] as string) || resolvedEnv('ZEPH_BASE_URL') || config.baseUrl || DEFAULT_API_BASE;
    setAttachmentContext({ apiKey, baseUrl });

    const wsUrl = resolveWsUrl(args, config, baseUrl);
    if (!wsUrl) {
        console.error(
            'zeph listener: WebSocket URL not set. Either:\n' +
            '  • add "wsUrl": "wss://..." to ~/.zeph/config.json\n' +
            '  • export ZEPH_WS_URL=wss://...\n' +
            '  • pass --ws-url wss://...',
        );
        return 1;
    }

    writeListenerPid();
    process.on('exit', removeListenerPid);

    // Rotate before writing anything, so this run's first line lands in the
    // file the user tails rather than being copied straight into `.old`. The
    // daemon owns this: under the login-time LaunchAgent nothing else runs
    // first — launchd opens StandardOutPath and execs us directly.
    rotateListenerLogIfLarge();

    // Version on the first line: the only way to tell which build a
    // long-lived daemon is actually running (an `npm i -g` days ago says
    // nothing about the process that's been up since before it).
    log(`zeph listener starting — v${VERSION} — ${wsUrl}`);
    log(`device=${computeListenerDeviceId()} host=${hostname()} pid=${process.pid}`);
    log("Waiting for 'agent.command' pushes from the phone picker. Ctrl-C to stop.");

    // Idle sleep kills the socket; "Wake for network access" does not bring it
    // back (see keep-awake.ts). Flag beats config; the default is on.
    const keepAwake = startKeepAwake({
        enabled: args['no-keep-awake'] !== true && config.keepAwake !== false,
        log,
    });

    // Heartbeat memory log — once an hour. Lets the user (and us) spot
    // gradual growth in a long-running daemon before it gets bad enough
    // to make the host shell unresponsive. The MB counter is human-
    // readable and tiny enough not to bloat the log.
    const HEAP_LOG_INTERVAL_MS = 60 * 60 * 1000;
    const heapLogTimer = setInterval(() => {
        const m = process.memoryUsage();
        const mb = (n: number) => Math.round(n / 1024 / 1024);
        log(`heap: rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB external=${mb(m.external)}MB`);
    }, HEAP_LOG_INTERVAL_MS);
    heapLogTimer.unref();

    // Sweep stale attachment dirs at startup, then hourly. Keeps
    // ~/.zeph/attachments from growing without bound over a long run.
    const sweepAttachments = (): void => {
        const n = gcAttachments();
        if (n > 0) log(`gc: removed ${n} stale attachment dir(s)`);
    };
    sweepAttachments();
    const gcTimer = setInterval(sweepAttachments, 60 * 60 * 1000);
    gcTimer.unref();

    // Rotate our own log. `spawnListenerDetached` rotates before it opens the
    // file, but the login-time LaunchAgent never goes through that function —
    // launchd opens StandardOutPath itself. Left alone, a daemon that survives
    // logins for weeks writes an unbounded log, so the daemon rotates itself.
    const logRotateTimer = setInterval(rotateListenerLogIfLarge, 60 * 60 * 1000);
    logRotateTimer.unref();

    // Agent detection rules: disk cache immediately (offline-safe),
    // then a background OTA refresh now and every 6 h (§S7).
    loadManifestFromCache();
    const refreshRules = (): void => {
        void refreshManifest().then((r) => {
            log(`rules: source=${r.source} outcome=${r.outcome}${r.version ? ` version=${r.version}` : ''}`);
        });
    };
    refreshRules();
    const rulesTimer = setInterval(refreshRules, RULES_REFRESH_INTERVAL_MS);
    rulesTimer.unref();

    let shuttingDown = false;
    let activeHandle: StreamHandle | null = null;
    // Resolved by stop() so the reconnect backoff sleep below can be
    // interrupted — otherwise a SIGINT during the (up to 30s) backoff waits
    // out the full delay before the loop notices shuttingDown.
    let notifyStop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => { notifyStop = resolve; });
    const stop = (sig: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`received ${sig}, stopping`);
        // Force-close any open WS so the streamSession promise resolves
        // immediately instead of waiting for the server to drop us.
        activeHandle?.terminate();
        keepAwake.stop();
        notifyStop();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    inventoryOffload = startInventoryOffload(collectSessionsVerbose, log);
    let attempt = 0;
    while (!shuttingDown) {
        activeHandle = streamSession(wsUrl, apiKey);
        const result = await activeHandle.done;
        activeHandle = null;

        if (AUTH_FAILURE_CODES.has(result.closeCode ?? -1)) {
            console.error(`zeph listener: auth failure (${result.closeCode} ${result.reason}). Check API key.`);
            inventoryOffload.close();
            removeListenerPid();
            return 3;
        }

        if (shuttingDown) break;

        // A session that actually connected resets the backoff — otherwise a
        // long-lived daemon on a flaky link ratchets up to the 30s ceiling
        // permanently, even when every reconnect succeeds instantly.
        if (result.connected) attempt = 0;

        const delay = computeBackoff(attempt);
        log(`disconnected (code=${result.closeCode}) — reconnect in ${Math.round(delay / 1000)}s`);
        await Promise.race([sleep(delay), stopped]);
        attempt = Math.min(attempt + 1, 10);
    }

    inventoryOffload.close();
    removeListenerPid();
    return 0;
};
