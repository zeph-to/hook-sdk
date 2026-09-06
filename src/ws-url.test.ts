import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_API_BASE, DEFAULT_WS_URL, endpointStage, parseListenerStartUrl, resolveWsUrlDetailed,
} from './ws-url.js';

const original = process.env.ZEPH_WS_URL;
beforeEach(() => { delete process.env.ZEPH_WS_URL; });
afterEach(() => {
    if (original === undefined) delete process.env.ZEPH_WS_URL;
    else process.env.ZEPH_WS_URL = original;
});

// Four inputs can supply this URL and the listener reads it once, at startup.
// Reporting WHICH one won is the whole point — "config isn't being read" was
// unanswerable before, because nothing ever said what had been read instead.
describe('resolveWsUrlDetailed', () => {
    it('names the flag when --ws-url is passed', () => {
        expect(resolveWsUrlDetailed({ 'ws-url': 'wss://flag' }, { wsUrl: 'wss://cfg' }, DEFAULT_API_BASE))
            .toEqual({ url: 'wss://flag', source: 'flag' });
    });

    it('names the environment when ZEPH_WS_URL is set', () => {
        process.env.ZEPH_WS_URL = 'wss://env';
        expect(resolveWsUrlDetailed({}, { wsUrl: 'wss://cfg' }, DEFAULT_API_BASE))
            .toEqual({ url: 'wss://env', source: 'env' });
    });

    it('names the config file when it is what supplied the value', () => {
        expect(resolveWsUrlDetailed({}, { wsUrl: 'wss://ws-dev.zeph.to' }, DEFAULT_API_BASE))
            .toEqual({ url: 'wss://ws-dev.zeph.to', source: 'config' });
    });

    it('names the default when nothing else did', () => {
        expect(resolveWsUrlDetailed({}, {}, DEFAULT_API_BASE))
            .toEqual({ url: DEFAULT_WS_URL, source: 'default' });
    });

    // Falling back to the prod socket while REST talks elsewhere would split
    // the device across environments, so that combination refuses instead.
    it('refuses to guess when the API base is not the prod default', () => {
        expect(resolveWsUrlDetailed({}, {}, 'https://api.zeph.to/d1')).toBeNull();
    });
});

describe('endpointStage', () => {
    it('reads a stage marker out of the hostname', () => {
        expect(endpointStage('wss://ws-dev.zeph.to')).toBe('dev');
        expect(endpointStage('https://api-staging.zeph.to/v1')).toBe('staging');
        expect(endpointStage('wss://ws.local.zeph.to')).toBe('local');
    });

    it('calls an unmarked host prod', () => {
        expect(endpointStage('wss://ws.zeph.to')).toBe('prod');
        expect(endpointStage(DEFAULT_API_BASE)).toBe('prod');
    });

    // The REST stage lives in the path, not the host: prod and dev share
    // api.zeph.to and differ only by /v1 vs /d1. Reading the host alone made a
    // correctly paired dev setup (api.zeph.to/d1 + ws-dev.zeph.to) look split.
    it('reads the API stage out of the path prefix', () => {
        expect(endpointStage('https://api.zeph.to/d1')).toBe('dev');
        expect(endpointStage('https://api.zeph.to/v1')).toBe('prod');
    });

    it('agrees that api.zeph.to/d1 and ws-dev.zeph.to are the same stage', () => {
        expect(endpointStage('https://api.zeph.to/d1')).toBe(endpointStage('wss://ws-dev.zeph.to'));
    });

    // "development.zeph.to" is not the `-dev` marker; only a whole segment is.
    it('does not fire on a substring inside a longer word', () => {
        expect(endpointStage('wss://device.zeph.to')).toBe('prod');
    });

    it('survives a value that is not a URL at all', () => {
        expect(endpointStage('not a url')).toBe('prod');
    });
});

// The daemon reads config once and can outlive an edit by hours. Its startup
// line is the only record of what it actually connected to.
describe('parseListenerStartUrl', () => {
    const line = (time: string, ver: string, url: string) =>
        `[${time}] zeph listener starting — v${ver} — ${url}\n`;

    it('takes the most recent start, not the first', () => {
        const log = line('03:26:20', '2.12.0', 'wss://ws.zeph.to')
            + '[03:26:21] device=dev_listener_abc host=mac pid=1\n'
            + line('07:42:50', '2.12.1', 'wss://ws-dev.zeph.to');
        expect(parseListenerStartUrl(log)).toBe('wss://ws-dev.zeph.to');
    });

    it('returns null for a log with no start line', () => {
        expect(parseListenerStartUrl('[03:26:21] device=dev_listener_abc host=mac pid=1\n')).toBeNull();
        expect(parseListenerStartUrl('')).toBeNull();
    });
});
