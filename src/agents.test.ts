import { describe, expect, it } from 'vitest';
import { hasCommand, resolveCommand } from './agents.js';

// resolveCommand is what makes the wrapper's execve handoff possible:
// process.execve does no PATH lookup of its own, so a bare name has to become
// an absolute path before the process can be replaced.

describe('resolveCommand', () => {
    it('resolves a command on PATH to an absolute path', () => {
        const found = resolveCommand('node');
        expect(found).toMatch(/^\//);
        expect(found).toContain('node');
    });

    it('returns null for a command that is not on PATH', () => {
        expect(resolveCommand('definitely-not-a-real-binary-xyz')).toBeNull();
    });

    // The previous implementation built `which ${cmd}` as a shell string. That
    // ran whatever the argument contained, and split any path with a space in
    // it into two words.
    it('never hands its argument to a shell', () => {
        expect(resolveCommand('nope; echo injected')).toBeNull();
    });
});

describe('hasCommand', () => {
    it('agrees with resolveCommand', () => {
        expect(hasCommand('node')).toBe(true);
        expect(hasCommand('definitely-not-a-real-binary-xyz')).toBe(false);
    });
});
