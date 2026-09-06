/**
 * `zeph cc` / `zeph codex` / `zeph gemini` — spawn an agent inside a named
 * tmux session so the resident listener (`zeph listener`) can address it
 * by session name to inject messages later.
 *
 * The tmux session name follows `zeph-<project>` where <project> resolves
 * from CLAUDE/CURSOR/WINDSURF_PROJECT_DIR → git repo root → cwd basename.
 * When the wrapper is invoked from inside an existing tmux session
 * ($TMUX set) it skips the outer tmux to avoid nesting and execs the
 * agent directly — letting power users keep their own multiplexer setup.
 */
import { execFileSync, spawn, spawnSync } from 'child_process';
import { basename } from 'path';
import { resolveCommand } from './agents.js';
import { isNewer } from './check-update.js';
import { PROJECT_DIR_ENV_VARS, resolvedEnv, VERSION } from './config.js';
import {
    LISTENER_LOG_FILE,
    runningListenerPid,
    runningListenerVersion,
    spawnListenerDetached,
    stopListener,
} from './listener-process.js';
import { restartService, serviceInstalled } from './listener-service.js';
import type { RemoteAgent } from './remote-agents.js';

const FALLBACK_NAME = 'project';

/** basename(), with a stable fallback for edge paths like `/`. */
const safeBasename = (path: string): string => basename(path) || FALLBACK_NAME;

/** Resolve a project name for the tmux session: env > git root > cwd basename. */
export const detectProjectName = (): string => {
    for (const key of PROJECT_DIR_ENV_VARS) {
        const v = resolvedEnv(key);
        if (v) return safeBasename(v.replace(/\/+$/, ''));
    }
    try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (root) return safeBasename(root);
    } catch { /* not a git repo — fall through */ }
    return safeBasename(process.cwd());
};

/** `zeph-<project>` — the canonical tmux session base name. */
export const tmuxSessionName = (project: string): string => `zeph-${project}`;

/**
 * Every live tmux session as `name → attached`, in one spawn.
 *
 * `tmux list-sessions` exits non-zero when no server is running; that is the
 * ordinary "first `zeph cc` after a reboot" case, not an error, and it means
 * an empty family.
 *
 * The format puts the 0/1 flag first so the name — which carries whatever the
 * project directory was called, spaces included — is everything after the
 * first space and needs no quoting.
 */
const liveSessions = (): Map<string, boolean> => {
    const r = spawnSync('tmux', ['list-sessions', '-F', '#{session_attached} #{session_name}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = new Map<string, boolean>();
    if (r.status !== 0) return out;
    for (const line of (r.stdout ?? '').split('\n')) {
        const sep = line.indexOf(' ');
        if (sep < 0) continue;
        out.set(line.slice(sep + 1), line.slice(0, sep) === '1');
    }
    return out;
};

const MAX_SUFFIX_ATTEMPTS = 20;

/** `<base>`, `<base>-2`, `<base>-3`, … — the session family for one project. */
const familyNames = (base: string): string[] =>
    Array.from({ length: MAX_SUFFIX_ATTEMPTS }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));

/**
 * Pick a tmux session name that won't steal focus from another live
 * `zeph cc`. Strategy:
 *   - Reuse the **highest-numbered detached** session in the family.
 *   - Otherwise take the lowest name that doesn't exist yet (create new),
 *     so an all-attached family gets an independent `<base>-N`.
 *
 * Highest-detached rather than lowest is what keeps the family reachable.
 * The old scan walked the family in order and returned the first session that
 * was missing *or* detached, which meant a detached `<base>` ended the scan
 * every time: `<base>-2` could not be reached by any later `zeph cc`, not even
 * after `<base>` was used and exited (a missing `<base>` is taken fresh). A
 * session nobody can reach still holds a live agent — a Claude Code CLI plus
 * its MCP fleet, 250-550MB measured — so stranding one leaks memory the user
 * can neither see nor reclaim. Draining from the tail makes every suffix
 * reachable again: the tail goes first, and `<base>` is picked on the run
 * after that. Reuse also wins over a gap in the numbering, for the same
 * reason — a free `<base>-2` must not hide a detached `<base>-3`.
 *
 * Reclaiming is deliberately all this does. Killing a detached session would
 * take a live agent with it, and nothing here can tell "the user is done with
 * this" from "the user closed the terminal and will come back".
 */
export const findAvailableSession = (base: string): string => {
    const live = liveSessions();
    const family = familyNames(base);
    for (let i = family.length - 1; i >= 0; i--) {
        if (live.get(family[i]) === false) return family[i];
    }
    return family.find((name) => !live.has(name)) ?? base;
};

interface SpawnTarget {
    /**
     * `tmux-new` opens (or reattaches) a session and needs a terminal to
     * attach to; `direct` runs the agent in the pane we are already in and
     * does not. Several decisions downstream turn on which one this is, so
     * `targetForAgent` states it rather than letting them re-derive it from
     * `cmd === 'tmux'`.
     */
    kind: 'direct' | 'tmux-new';
    cmd: string;
    args: string[];
}

/** POSIX shell-quote so passthrough args survive being joined into a tmux shell-command string. */
const SHELL_SAFE = /^[\w\-./=:@%+,]+$/;
const shellQuote = (s: string): string =>
    s.length > 0 && SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

export const targetForAgent = (agent: string, extra: string[]): SpawnTarget => {
    // Already inside tmux → no nested session, just run the agent in the
    // current pane. Nested tmux prefix collisions are confusing and the
    // listener can't reach a session it didn't name anyway.
    if (process.env.TMUX) {
        return { kind: 'direct', cmd: agent, args: extra };
    }
    const base = tmuxSessionName(detectProjectName());
    // Reattach a detached session of this project when there is one,
    // else auto-suffix — lets the user keep `zeph cc` workflow simple and
    // still get independent sessions when opening multiple terminals in
    // the same project.
    const session = findAvailableSession(base);
    // `tmux new -A`: attach if the named session exists, else create it.
    // tmux joins trailing argv into a single shell-command, so flags like
    // `--resume` would be eaten by tmux's own parser. Build one quoted
    // shell string instead, which tmux passes through verbatim.
    const shellCmd = [agent, ...extra].map(shellQuote).join(' ');
    return { kind: 'tmux-new', cmd: 'tmux', args: ['new', '-A', '-s', session, shellCmd] };
};

// ── Background listener auto-start ────────────────────────────────────

/**
 * Whether the daemon on record is running a different build than the one
 * we're launching from. `npm i -g @zeph-to/cli` swaps dist/ but leaves the
 * live process untouched, so a daemon can stay days behind the installed
 * package — answering pushes (chat looks fine) while silently ignoring every
 * message subtype added since it booted. That is exactly how a pre-1.24
 * listener left the phone's live terminal spinning until a reboot.
 *
 * A missing stamp means the daemon predates version stamping, which puts it
 * behind by definition — treat unknown as drifted.
 *
 * Strictly "installed is newer", never a plain inequality: one account can
 * have several installs at different versions (nvm node versions, a repo
 * build alongside the global one), and `!==` would make each `zeph cc` kill
 * and respawn the other's daemon forever. An older `zeph cc` leaves a newer
 * daemon alone — downgrading it would reintroduce the very gap this closes.
 */
export const listenerVersionDrifted = (running: string | null, installed: string): boolean =>
    running === null || isNewer(installed, running);

/**
 * Make sure the phone-bridge daemon is running AND is the build we just
 * launched from. `zeph cc` is the right moment to replace a drifted one: the
 * user is starting fresh work rather than mid-task, so the ~1s restart window
 * (in which a push would be dropped — WS fan-out has no queue) costs nothing.
 */
export const ensureListenerRunning = async (): Promise<void> => {
    const pid = runningListenerPid();
    const running = pid === null ? null : runningListenerVersion();
    if (pid !== null && !listenerVersionDrifted(running, VERSION)) return;

    // When the login-time service is installed, launchd owns this process.
    // Stopping its child makes launchd start a replacement while we spawn our
    // own, and the two race through the singleton guard in handleListener —
    // whichever loses exits 0, and if that is launchd's child, KeepAlive
    // either flaps it every ThrottleInterval or reads the clean exit as
    // deliberate and gives up for the rest of the login session. Ask launchd
    // to do it instead; `kickstart -k` replaces a drifted daemon in one step.
    if (serviceInstalled()) {
        const result = restartService();
        if (!result.ok) {
            console.error(`zeph: could not start the listener service — ${result.reason}`);
            return;
        }
        if (pid === null) console.log(`zeph: listener started by launchd (log: ${LISTENER_LOG_FILE})`);
        else console.log(`zeph: listener ${running ?? '(pre-1.26)'} is stale — launchd restarting on ${VERSION}`);
        return;
    }

    if (pid !== null) {
        console.log(`zeph: listener ${running ?? '(pre-1.26)'} is stale — restarting on ${VERSION}`);
        await stopListener(pid);
    }
    if (spawnListenerDetached()) {
        if (pid === null) console.log(`zeph: listener autostarted in background (log: ${LISTENER_LOG_FILE})`);
    } else {
        console.error('zeph: listener autostart failed — run `zeph listener` manually.');
    }
};

/**
 * Launch the agent in a named tmux session (or directly if nested) and
 * forward its exit code. `extra` is appended to the agent invocation, so
 * `zeph cc --resume foo` runs `claude --resume foo` inside the session.
 * Returns when the agent exits.
 */
/** `process.execve` with the optionality resolved — see handOffExec. */
export type ProcessHandOff = NonNullable<typeof process.execve>;

/**
 * The exec that replaces this process with the child, or null when the wrapper
 * has to stay and wait instead. Returning the function rather than a boolean
 * keeps one check where two would otherwise drift: the platform gate and the
 * policy are the same answer.
 *
 * `process.execve` is declared optional by @types/node, and is absent on node
 * <22.15 (added there) and on Windows (its doc: "not available on Windows or
 * IBM i"), so its presence covers both without a version check. `engines.node`
 * is `>=18`, so the spawn path below is not a transitional fallback — it stays.
 *
 * `isTTY` is `undefined` rather than `false` on a pipe, hence every `=== true`.
 */
export const handOffExec = (deps: {
    execve: ProcessHandOff | undefined;
    kind: SpawnTarget['kind'];
    stdinTTY: boolean | undefined;
    stdoutTTY: boolean | undefined;
}): ProcessHandOff | null => {
    if (!deps.execve) return null;
    // execve runs no cleanup handler, and node only writes stdout synchronously
    // to a TTY on POSIX — anything buffered to a pipe would vanish with us.
    if (deps.stdoutTTY !== true) return null;
    // `tmux new` additionally needs a terminal of its own to attach to. That is
    // the failure the spawn path below exists to explain, so send it there.
    if (deps.kind === 'tmux-new' && deps.stdinTTY !== true) return null;
    return deps.execve;
};

export const handleAgentSession = async (agent: RemoteAgent, extra: string[] = []): Promise<number> => {
    // Best-effort: make sure the phone-bridge daemon is running, and running
    // the build we were launched from. The user shouldn't need to remember a
    // second command for the picker on their phone to work.
    await ensureListenerRunning();
    const { kind, cmd, args } = targetForAgent(agent.binary, extra);

    // Hand the terminal over and stop existing. Waiting on the child is all
    // this process does for the rest of the session, and it holds a whole node
    // heap to do it — one resident process per `zeph cc`, purely to forward an
    // exit code that execve gives us for free by being the same process.
    const handOff = handOffExec({
        execve: process.execve,
        kind,
        stdinTTY: process.stdin.isTTY,
        stdoutTTY: process.stdout.isTTY,
    });
    if (handOff) {
        const file = resolveCommand(cmd);
        // execve does no PATH lookup, so resolving is mandatory — and the
        // resolve failing is the same fact the spawn path learns from ENOENT.
        if (!file) {
            console.error(`zeph: '${cmd}' not found on PATH`);
            return 127;
        }
        // Nothing buffered survives: execve runs no cleanup handler and fires
        // no exit event. Safe here only because stdout is a TTY, which node
        // writes synchronously on POSIX — every `zeph:` line above is already out.
        // The env argument is left off: it defaults to process.env.
        handOff(file, [cmd, ...args]);
    }

    return new Promise<number>((resolve) => {
        const start = Date.now();
        const child = spawn(cmd, args, { stdio: 'inherit' });
        child.on('exit', (code) => {
            const dur = Date.now() - start;
            // Short-lived non-zero exits are the symptom of "ran from a
            // pane that isn't a real TTY" (some IDE terminals). The user
            // otherwise just sees their shell return with `[exited]` and no
            // clue what went wrong. Only `tmux new` fails that way — telling
            // someone whose agent died inside a perfectly good pane to "run
            // from a plain shell pane" would send them after the wrong thing.
            if (kind === 'tmux-new' && code && code !== 0 && dur < 2000) {
                console.error(
                    `zeph: ${cmd} ${args.join(' ')} exited ${code} after ${dur}ms.\n` +
                    `  If this terminal is itself inside tmux (or an iTerm/Warp\n` +
                    `  tmux-integration pane), run \`zeph cc\` from a plain shell\n` +
                    `  pane instead — \`tmux new\` needs a real TTY to attach.`,
                );
            }
            resolve(code ?? 0);
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                console.error(`zeph: '${cmd}' not found on PATH`);
                resolve(127);
            } else {
                console.error(`zeph: failed to spawn ${cmd}: ${err.message}`);
                resolve(1);
            }
        });
    });
};
