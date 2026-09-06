import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Process-level facts about the resident `zeph listener` daemon: where its
 * PID/version stamps live, whether one is alive, how to stop it and how to
 * respawn it detached.
 *
 * This lives OUTSIDE listener.ts on purpose. `wrapper.ts` (the `zeph cc` hot
 * path) needs all of it, and importing listener.ts there would drag `ws` +
 * the crypto stack into every agent launch. Same split as
 * listener-device-id.ts — one small module both sides can read.
 *
 * Why a version stamp at all: `npm i -g @zeph-to/cli` replaces the package on
 * disk but NOT the daemon already running from the old dist. That daemon
 * keeps answering pushes (so chat looks fine) while silently ignoring every
 * subtype added since it started — which is exactly how a pre-1.24 listener
 * left the phone's live terminal spinning until the machine was rebooted.
 * Stamping the version next to the PID makes that drift detectable.
 */

const ZEPH_DIR = join(homedir(), '.zeph');
export const LISTENER_PID_FILE = join(ZEPH_DIR, 'listener.pid');
/** CLI version the running daemon booted from. Absent ⇒ pre-stamp build. */
export const LISTENER_VERSION_FILE = join(ZEPH_DIR, 'listener.version');
/**
 * The socket the running daemon actually connected to. A stamp rather than a
 * line in listener.log, because the log rotates at 5MB and a long-lived daemon
 * — exactly the one whose config edit has been outlived — loses its own startup
 * line to that rotation, which would silently switch the staleness check off.
 */
export const LISTENER_WS_URL_FILE = join(ZEPH_DIR, 'listener.wsurl');
export const LISTENER_LOG_FILE = join(ZEPH_DIR, 'listener.log');

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PID of the listener on record, or null when the file is missing or stale.
 * Stale PID files (process gone) read as "no listener" so a crashed daemon
 * never blocks the next autostart.
 */
export const runningListenerPid = (): number | null => {
    try {
        const pid = Number(readFileSync(LISTENER_PID_FILE, 'utf-8').trim());
        if (!Number.isFinite(pid) || pid <= 0) return null;
        process.kill(pid, 0); // signal 0 = existence check, throws when gone
        return pid;
    } catch {
        return null;
    }
};

/**
 * CLI version the running daemon started from, or null when unknown.
 * null is meaningful: every build before the stamp existed predates the
 * live-terminal protocol, so callers treat "unknown" as "stale".
 */
export const runningListenerVersion = (): string | null => {
    try {
        return readFileSync(LISTENER_VERSION_FILE, 'utf-8').trim() || null;
    } catch {
        return null;
    }
};

/** Claim the singleton slot for THIS process and stamp the version with it. */
export const writeListenerRuntime = (version: string, wsUrl?: string): void => {
    mkdirSync(ZEPH_DIR, { recursive: true });
    writeFileSync(LISTENER_PID_FILE, String(process.pid));
    writeFileSync(LISTENER_VERSION_FILE, version);
    if (wsUrl) writeFileSync(LISTENER_WS_URL_FILE, wsUrl);
};

/** The socket the running daemon connected to, or null when it is unknown. */
export const runningListenerWsUrl = (): string | null => {
    if (runningListenerPid() === null) return null;
    try {
        return readFileSync(LISTENER_WS_URL_FILE, 'utf-8').trim() || null;
    } catch {
        return null;
    }
};

/**
 * Drop the PID/version stamps, but only when they still name `pid` — a
 * successor that already claimed the slot must not be trampled by a
 * predecessor's exit handler.
 */
export const clearListenerRuntime = (pid: number): void => {
    try {
        if (!existsSync(LISTENER_PID_FILE)) return;
        if (Number(readFileSync(LISTENER_PID_FILE, 'utf-8').trim()) !== pid) return;
        unlinkSync(LISTENER_PID_FILE);
        for (const stamp of [LISTENER_VERSION_FILE, LISTENER_WS_URL_FILE]) {
            try {
                unlinkSync(stamp);
            } catch { /* best-effort — a missing stamp is already the desired state */ }
        }
    } catch { /* best-effort */ }
};

/**
 * Drop stamps left behind by a daemon that died without running its exit
 * handler (crash, SIGKILL, reboot-era leftovers). No-op while one is alive.
 */
export const clearStaleListenerRuntime = (): void => {
    if (runningListenerPid() !== null) return;
    try {
        unlinkSync(LISTENER_PID_FILE);
    } catch { /* nothing to clear */ }
    try {
        unlinkSync(LISTENER_VERSION_FILE);
    } catch { /* nothing to clear */ }
};

/**
 * Stop the daemon and wait for the process to actually go away. SIGTERM
 * first so its exit handler clears the stamps, SIGKILL once the grace window
 * expires. Resolves true when the process is confirmed gone.
 *
 * Waiting matters: the caller's next move is spawning a replacement, and two
 * live daemons on one machine both answer the same pushes.
 */
export const stopListener = async (pid: number, timeoutMs = 3_000): Promise<boolean> => {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return true; // already gone
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(50);
        try {
            process.kill(pid, 0);
        } catch {
            clearListenerRuntime(pid);
            return true;
        }
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch { /* raced us to exit */ }
    clearListenerRuntime(pid);
    return false;
};

/**
 * Path to the running cli.js entry. wrapper.js/listener.js sit next to cli.js
 * in dist/, so __dirname resolves it directly — independent of how the user
 * invoked us.
 *
 * `process.argv[1]` is unreliable here: when `zeph` runs via the npm-installed
 * bin shim (`/usr/local/bin/zeph` → cli.js via a wrapper script), argv[1] is
 * the shim path (`.../bin/zeph`), NOT `cli.js`. That made the original
 * `/cli\.(js|ts|mjs|cjs)$/` check silently reject the entry and the autospawn
 * never fired — the bug only surfaced once the user switched to the global
 * npm install.
 *
 * Fall back to argv[1] only when the __dirname-relative file doesn't exist
 * (some packaging where dist layout differs).
 */
export const resolveCliPath = (): string | null => {
    const local = join(__dirname, 'cli.js');
    if (existsSync(local)) return local;
    const entry = process.argv[1];
    if (entry && /cli\.(js|ts|mjs|cjs)$/.test(entry)) return entry;
    return null;
};

/**
 * Rotate the listener log once it grows past 5 MB. The daemon runs for days
 * and writes 2-3 lines per 5-s cycle, so without rotation the file climbs
 * into the tens of megabytes. Keep the previous window under `.old`.
 *
 * Copy-truncate rather than rename, because the writer is not always ours.
 * Under the login-time LaunchAgent, launchd opens `StandardOutPath` itself
 * and holds that fd for the life of the job: a rename moves the directory
 * entry and leaves launchd appending to the very same inode, now called
 * `.old`. The log the user tails would never shrink. Emptying the file in
 * place keeps the inode — and the fd — valid.
 */
const LISTENER_LOG_MAX_BYTES = 5 * 1024 * 1024;

export const rotateListenerLogIfLarge = (): void => {
    try {
        if (!existsSync(LISTENER_LOG_FILE)) return;
        if (statSync(LISTENER_LOG_FILE).size <= LISTENER_LOG_MAX_BYTES) return;
        copyFileSync(LISTENER_LOG_FILE, LISTENER_LOG_FILE + '.old');
        truncateSync(LISTENER_LOG_FILE, 0);
    } catch { /* best-effort */ }
};

/**
 * Launch `zeph listener` detached, with output appended to the listener log
 * so nothing is lost once we let go of it. Returns false when the cli entry
 * couldn't be resolved or the spawn failed — the caller decides how loud that
 * is (autostart is best-effort, an explicit `--restart` is not).
 */
export const spawnListenerDetached = (): boolean => {
    const cliPath = resolveCliPath();
    if (!cliPath) return false;
    try {
        mkdirSync(ZEPH_DIR, { recursive: true });
        const out = openSync(LISTENER_LOG_FILE, 'a');
        const child = spawn(process.execPath, [cliPath, 'listener'], {
            detached: true,
            stdio: ['ignore', out, out],
            env: { ...process.env, ZEPH_LISTENER_AUTOSTART: '1' },
        });
        child.unref();
        return true;
    } catch {
        return false;
    }
};
