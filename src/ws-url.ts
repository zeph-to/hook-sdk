/**
 * Where the listener's WebSocket URL comes from.
 *
 * The listener reads this once, at startup, and four things can supply it —
 * which is exactly why a machine can sit on the wrong stage for hours with
 * nothing to show for it but a line buried in listener.log. `zeph verify`
 * reports the answer AND its source, so "config isn't being read" stops being
 * a guess.
 *
 * Its own module rather than listener.ts so `zeph verify` can ask without
 * loading the 187KB daemon.
 */
import { resolvedEnv } from './config.js';

export const DEFAULT_API_BASE = 'https://api.zeph.to/v1';
export const DEFAULT_WS_URL = 'wss://ws.zeph.to';

/** Which of the four inputs won. Reported to the user verbatim. */
export type WsUrlSource = 'flag' | 'env' | 'config' | 'default';

export interface ResolvedWsUrl {
    readonly url: string;
    readonly source: WsUrlSource;
}

/**
 * A user who only set ZEPH_API_KEY (no `zeph login`, no config file) gets the
 * prod socket by default — mirroring the DEFAULT_API_BASE fallback for REST.
 * The default only applies when the base URL is also the prod default: with a
 * custom base URL, silently pointing the listener at the prod socket while
 * REST talks to another stage would split the device across environments, so
 * that combination still errors loudly.
 */
export const resolveWsUrlDetailed = (
    args: Record<string, string | boolean>,
    config: { wsUrl?: string },
    baseUrl: string,
): ResolvedWsUrl | null => {
    const fromArg = typeof args['ws-url'] === 'string' ? (args['ws-url'] as string) : null;
    if (fromArg) return { url: fromArg, source: 'flag' };

    const fromEnv = resolvedEnv('ZEPH_WS_URL');
    if (fromEnv) return { url: fromEnv, source: 'env' };

    if (config.wsUrl) return { url: config.wsUrl, source: 'config' };

    return baseUrl === DEFAULT_API_BASE ? { url: DEFAULT_WS_URL, source: 'default' } : null;
};

/** The URL alone — the listener's own question. One precedence list, not two. */
export const resolveWsUrl = (
    args: Record<string, string | boolean>,
    config: { wsUrl?: string },
    baseUrl: string,
): string | null => resolveWsUrlDetailed(args, config, baseUrl)?.url ?? null;

/**
 * Stage label for a zeph endpoint. The two endpoints carry it differently, and
 * both forms have to be read or a correctly paired dev setup reports as broken:
 *
 * - The REST base encodes it in the PATH PREFIX — `/v1` is prod, `/d1` is dev,
 *   on the same `api.zeph.to` host (see agent-rules-fetch.ts).
 * - The socket encodes it in the HOSTNAME — `ws.zeph.to` vs `ws-dev.zeph.to`,
 *   with no path at all.
 *
 * Only used to notice that the two point at different stages — a split-brain
 * device, pushes going one way and the agent list the other. Never blocks.
 */
const API_STAGE_PREFIX: Record<string, string> = { v1: 'prod', d1: 'dev' };

export const endpointStage = (url: string): string => {
    let host = url;
    let path = '';
    try {
        const parsed = new URL(url);
        host = parsed.hostname;
        path = parsed.pathname;
    } catch { /* not a URL — fall through and read it as a hostname */ }

    // Host marker first: it is explicit, and it outranks the path. An
    // `api-staging.zeph.to/v1` is staging — the `/v1` there says "the v1 API of
    // the staging deployment", not "prod".
    const marked = host.match(/(?:^|[.-])(dev|stage|staging|local|test)(?:[.-]|$)/);
    if (marked) return marked[1];

    // Unmarked host: the path prefix is the only thing left that carries a
    // stage, and on api.zeph.to it is the whole distinction.
    const prefix = path.split('/').filter(Boolean)[0];
    return (prefix && API_STAGE_PREFIX[prefix]) || 'prod';
};

/**
 * The URL the RUNNING listener actually connected to, read out of its own
 * startup line. The daemon resolves this once and can outlive a config edit by
 * hours, so "what the config says" and "what is connected" are different
 * questions — and only the second one explains a machine missing from the app.
 *
 * Matches the line listener.ts writes: `[HH:MM:SS] zeph listener starting — vX — <url>`.
 * Last one wins; the log accumulates every restart.
 */
export const parseListenerStartUrl = (logText: string): string | null => {
    const starts = [...logText.matchAll(/zeph listener starting\b.*?(\S+)\s*$/gm)];
    const last = starts.at(-1);
    return last ? last[1] : null;
};
