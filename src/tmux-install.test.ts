import { describe, expect, it } from 'vitest';
import { ensureTmux, planTmuxInstall } from './tmux-install.js';
import type { TmuxInstallPlan } from './tmux-install.js';

// `zeph cc` is tmux or nothing, but nothing in the install flow ever said so —
// the first a user heard about it was tmux's own error, or none at all.

const resolver = (present: string[]) => (cmd: string) => (present.includes(cmd) ? `/usr/bin/${cmd}` : null);

describe('planTmuxInstall', () => {
    it('reports tmux already present, with the path it found', () => {
        expect(planTmuxInstall({ resolve: resolver(['tmux']), platform: 'darwin' }))
            .toEqual({ kind: 'present', path: '/usr/bin/tmux' });
    });

    // Homebrew installs into a user-writable prefix, so this is the one case
    // we can carry out on the user's behalf without asking for root.
    it('offers to run brew on macOS when brew is there', () => {
        const plan = planTmuxInstall({ resolve: resolver(['brew']), platform: 'darwin' });
        expect(plan).toEqual({ kind: 'command', run: ['brew', 'install', 'tmux'], label: 'brew install tmux' });
    });

    it('falls back to an instruction on macOS without brew', () => {
        const plan = planTmuxInstall({ resolve: resolver([]), platform: 'darwin' });
        expect(plan.kind).toBe('manual');
        expect(plan).toHaveProperty('hint', expect.stringContaining('brew'));
    });

    // apt needs root. Running sudo out of an installer is not something to do
    // to someone, so Linux always gets the command to run rather than the act.
    it('never offers to run a package manager that needs root', () => {
        for (const pm of ['apt-get', 'dnf', 'pacman']) {
            const plan = planTmuxInstall({ resolve: resolver([pm]), platform: 'linux' });
            expect(plan.kind).toBe('manual');
            expect(JSON.stringify(plan)).toContain('sudo');
        }
    });

    it('names the right package manager per distro family', () => {
        expect(planTmuxInstall({ resolve: resolver(['apt-get']), platform: 'linux' }))
            .toHaveProperty('hint', expect.stringContaining('apt'));
        expect(planTmuxInstall({ resolve: resolver(['dnf']), platform: 'linux' }))
            .toHaveProperty('hint', expect.stringContaining('dnf'));
        expect(planTmuxInstall({ resolve: resolver(['pacman']), platform: 'linux' }))
            .toHaveProperty('hint', expect.stringContaining('pacman'));
    });

    // tmux has no Windows build; `zeph cc` is POSIX-only and says so rather
    // than sending someone after a package that does not exist.
    it('tells Windows users that zeph cc is not available there', () => {
        const plan = planTmuxInstall({ resolve: resolver([]), platform: 'win32' });
        expect(plan.kind).toBe('manual');
        expect(JSON.stringify(plan)).toMatch(/Windows|WSL/);
    });
});

describe('ensureTmux', () => {
    const spy = () => {
        const calls: string[] = [];
        return { calls, fn: (m: string) => { calls.push(m); } };
    };
    const harness = (over: Partial<Parameters<typeof ensureTmux>[0]> = {}) => {
        const ok = spy(); const fail = spy(); const note = spy();
        const ran: string[][] = [];
        const asked: string[] = [];
        return {
            ok, fail, note, ran, asked,
            deps: {
                plan: { kind: 'command', run: ['brew', 'install', 'tmux'], label: 'brew install tmux' } as TmuxInstallPlan,
                nonInteractive: false,
                askConfirm: async (m: string) => { asked.push(m); return true; },
                run: (argv: readonly string[]) => { ran.push([...argv]); },
                report: { ok: ok.fn, fail: fail.fn, note: note.fn },
                ...over,
            },
        };
    };

    it('says nothing to install when tmux is already there', async () => {
        const h = harness({ plan: { kind: 'present', path: '/opt/homebrew/bin/tmux' } });
        await ensureTmux(h.deps);
        expect(h.ok.calls[0]).toContain('/opt/homebrew/bin/tmux');
        expect(h.asked).toEqual([]);
        expect(h.ran).toEqual([]);
    });

    // A scripted install must never stop on a question or install software on
    // its own initiative; it reports and moves on.
    it('never prompts or installs in a non-interactive run', async () => {
        const h = harness({ nonInteractive: true });
        await ensureTmux(h.deps);
        expect(h.asked).toEqual([]);
        expect(h.ran).toEqual([]);
        expect(h.note.calls[0]).toContain('brew install tmux');
    });

    it('runs the package manager once the user agrees', async () => {
        const h = harness();
        await ensureTmux(h.deps);
        expect(h.asked[0]).toContain('brew install tmux');
        expect(h.ran).toEqual([['brew', 'install', 'tmux']]);
        expect(h.ok.calls).toContain('tmux installed');
    });

    it('installs nothing when the user declines, and says what is still needed', async () => {
        const h = harness({ askConfirm: async () => false });
        await ensureTmux(h.deps);
        expect(h.ran).toEqual([]);
        expect(h.note.calls[0]).toContain('brew install tmux');
    });

    // A failed `brew install` must not read as success two lines later.
    it('reports a failed install instead of swallowing it', async () => {
        const h = harness({ run: () => { throw new Error('brew: command failed'); } });
        await ensureTmux(h.deps);
        expect(h.ok.calls).not.toContain('tmux installed');
        expect(h.fail.calls[0]).toContain('brew install tmux');
    });

    it('only tells, never runs, when the plan needs root', async () => {
        const h = harness({ plan: { kind: 'manual', hint: 'sudo apt install tmux' } });
        await ensureTmux(h.deps);
        expect(h.asked).toEqual([]);
        expect(h.ran).toEqual([]);
        expect(h.fail.calls[0]).toContain('sudo apt install tmux');
    });
});
