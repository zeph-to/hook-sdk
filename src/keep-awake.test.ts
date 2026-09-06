import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { startKeepAwake } from './keep-awake.js';

// A stand-in for the caffeinate ChildProcess: an emitter with the two members
// keep-awake touches. Tests drive 'error' / 'exit' by hand.
const fakeChild = () => Object.assign(new EventEmitter(), { kill: vi.fn(() => true), unref: vi.fn() });

const harness = (over: Partial<Parameters<typeof startKeepAwake>[0]> = {}) => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof spawn;
    const log = vi.fn<(msg: string) => void>();
    const handle = startKeepAwake({ enabled: true, platform: 'darwin', pid: 4242, spawnFn, log, ...over });
    return { child, spawnFn, log, handle };
};

describe('startKeepAwake', () => {
    it('runs caffeinate -s -w <pid> on macOS, detached from the event loop', () => {
        const { child, spawnFn, log } = harness();
        expect(spawnFn).toHaveBeenCalledWith('caffeinate', ['-s', '-w', '4242'], { stdio: 'ignore' });
        expect(child.unref).toHaveBeenCalled();
        expect(log.mock.calls[0][0]).toMatch(/^keep-awake: caffeinate -s -w 4242/);
    });

    it('does nothing off macOS', () => {
        const { spawnFn, log } = harness({ platform: 'linux' });
        expect(spawnFn).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('says so, and spawns nothing, when disabled', () => {
        const { spawnFn, log } = harness({ enabled: false });
        expect(spawnFn).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^keep-awake: off/));
    });

    it('logs a missing caffeinate instead of throwing', () => {
        const { child, log } = harness();
        child.emit('error', new Error('spawn caffeinate ENOENT'));
        expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^! keep-awake: caffeinate unavailable \(spawn caffeinate ENOENT\)/));
    });

    it('warns when caffeinate dies on its own, but not when stop() killed it', () => {
        const early = harness();
        early.child.emit('exit', 1, null);
        expect(early.log).toHaveBeenLastCalledWith(expect.stringMatching(/^! keep-awake: caffeinate exited early \(1\)/));

        const stopped = harness();
        stopped.handle.stop();
        stopped.handle.stop();
        expect(stopped.child.kill).toHaveBeenCalledTimes(1);
        stopped.child.emit('exit', null, 'SIGTERM');
        expect(stopped.log).toHaveBeenCalledTimes(1);
    });
});
