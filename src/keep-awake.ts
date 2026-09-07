import { spawn } from 'node:child_process';

/**
 * Keep the host awake while the listener runs — macOS only.
 *
 * The listener holds an OUTBOUND WebSocket. macOS "Wake for network access"
 * only wakes the machine for inbound requests to Bonjour-advertised services,
 * so it does nothing for us: when the Mac idle-sleeps, the socket dies and the
 * phone sits on "Waiting for the live stream…" until the lid is opened. On a
 * machine that runs Claude Code this is masked — the agent spawns
 * `caffeinate -i -t 300` while a turn is running — which is why one Mac looks
 * fine and another, idling at a prompt, keeps dropping.
 *
 * `caffeinate -s -w <pid>`: `-s` blocks system sleep and is honoured ONLY on
 * AC power (macOS drops the assertion on battery, so this never drains a
 * laptop); `-w` releases it the moment our pid exits, so a crashed daemon
 * leaves no orphan holding the machine up. The display still sleeps; a closed
 * lid still sleeps — those are the user's call, not ours.
 */

export interface KeepAwakeOptions {
    /** `false` = `--no-keep-awake` / `"keepAwake": false` in config. */
    enabled: boolean;
    log: (msg: string) => void;
    platform?: NodeJS.Platform;
    pid?: number;
    spawnFn?: typeof spawn;
}

export interface KeepAwake {
    /** Release the assertion now rather than at process exit. Idempotent. */
    stop: () => void;
}

const NOOP: KeepAwake = { stop: () => undefined };

export const startKeepAwake = (opts: KeepAwakeOptions): KeepAwake => {
    if (!opts.enabled) {
        opts.log('keep-awake: off — the Mac may idle-sleep and drop the socket');
        return NOOP;
    }
    if ((opts.platform ?? process.platform) !== 'darwin') return NOOP;

    const pid = opts.pid ?? process.pid;
    const spawnFn = opts.spawnFn ?? spawn;
    const child = spawnFn('caffeinate', ['-s', '-w', String(pid)], { stdio: 'ignore' });
    let stopped = false;

    // ENOENT and friends arrive here, asynchronously — spawn itself does not
    // throw for a missing binary. Not fatal: the listener works without it,
    // the machine just sleeps like it did before.
    child.on('error', (err) => {
        stopped = true;
        opts.log(`! keep-awake: caffeinate unavailable (${err.message}) — the Mac may idle-sleep and drop the socket`);
    });
    child.on('exit', (code, signal) => {
        if (stopped) return;
        stopped = true;
        opts.log(`! keep-awake: caffeinate exited early (${code ?? signal}) — the Mac may idle-sleep and drop the socket`);
    });
    // Never keep the event loop alive on the child's account: the daemon's
    // lifetime is the socket loop's, and `-w` ties caffeinate to it anyway.
    child.unref();

    opts.log(`keep-awake: caffeinate -s -w ${pid} — blocks idle sleep on AC power only (--no-keep-awake to disable)`);
    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            child.kill();
        },
    };
};
