/**
 * tmux is not optional for `zeph cc` — every remote-agent subcommand runs the
 * agent inside a named tmux session so the listener (and the phone picker) can
 * reach it. Nothing in the install flow used to mention that, so a machine
 * without tmux looked fully set up until the first `zeph cc` failed with an
 * error from a program the user was never told they needed.
 */

/** What this machine can do about a missing tmux. */
export type TmuxInstallPlan =
    | { readonly kind: 'present'; readonly path: string }
    /** Safe to run unattended — no root, user-writable prefix. */
    | { readonly kind: 'command'; readonly run: readonly string[]; readonly label: string }
    /** Needs root, or there is no package manager we recognise. Tell, don't do. */
    | { readonly kind: 'manual'; readonly hint: string };

/** Package managers that need root, and the line to hand the user for each. */
const ROOT_PACKAGE_MANAGERS: ReadonlyArray<{ bin: string; hint: string }> = [
    { bin: 'apt-get', hint: 'sudo apt install tmux' },
    { bin: 'dnf', hint: 'sudo dnf install tmux' },
    { bin: 'pacman', hint: 'sudo pacman -S tmux' },
    { bin: 'zypper', hint: 'sudo zypper install tmux' },
    { bin: 'apk', hint: 'sudo apk add tmux' },
];

export const planTmuxInstall = (deps: {
    resolve: (cmd: string) => string | null;
    platform: NodeJS.Platform;
}): TmuxInstallPlan => {
    const path = deps.resolve('tmux');
    if (path) return { kind: 'present', path };

    // tmux has no native Windows build. `zeph cc` is POSIX-only by way of tmux,
    // so point at WSL rather than at a package that cannot be installed.
    if (deps.platform === 'win32') {
        return { kind: 'manual', hint: '`zeph cc` needs tmux, which has no Windows build — run it under WSL' };
    }

    if (deps.platform === 'darwin') {
        return deps.resolve('brew')
            ? { kind: 'command', run: ['brew', 'install', 'tmux'], label: 'brew install tmux' }
            : { kind: 'manual', hint: 'install Homebrew (brew.sh), then: brew install tmux' };
    }

    const rootManager = ROOT_PACKAGE_MANAGERS.find((pm) => deps.resolve(pm.bin));
    if (rootManager) return { kind: 'manual', hint: rootManager.hint };

    return { kind: 'manual', hint: 'install tmux with this system\'s package manager' };
};

/**
 * Act on the plan. Everything the outside world touches is injected, because
 * the interesting branch — "offer, then run a package manager" — is otherwise
 * only reachable through an interactive install that no test can drive.
 */
export const ensureTmux = async (deps: {
    plan: TmuxInstallPlan;
    nonInteractive: boolean;
    askConfirm: (message: string) => Promise<boolean>;
    run: (argv: readonly string[]) => void;
    report: { ok: (m: string) => void; fail: (m: string) => void; note: (m: string) => void };
}): Promise<void> => {
    const { plan, report } = deps;

    if (plan.kind === 'present') return report.ok(`tmux found (${plan.path})`);
    if (plan.kind === 'manual') return report.fail(`tmux not found — \`zeph cc\` needs it. ${plan.hint}`);

    if (deps.nonInteractive) {
        return report.note(`tmux not found — \`zeph cc\` needs it. Run: ${plan.label}`);
    }
    const wanted = await deps.askConfirm(
        `tmux is missing and \`zeph cc\` needs it — run \`${plan.label}\`? (enter to confirm)`,
    );
    if (!wanted) {
        return report.note(`tmux not installed — \`zeph cc\` will not work until you run: ${plan.label}`);
    }

    try {
        deps.run(plan.run);
        report.ok('tmux installed');
    } catch {
        report.fail(`\`${plan.label}\` failed — run it by hand`);
    }
};
