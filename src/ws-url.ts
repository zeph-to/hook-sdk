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
export const DEFAULT_API_BASE = 'https://api.zeph.to/v1';
export const DEFAULT_WS_URL = 'wss://ws.zeph.to';

/**
 * Which input won. Reported to the user verbatim.
 *
 * `ZEPH_WS_URL` used to sit ABOVE the config file, so an `export` in a shell
 * profile silently outranked `~/.zeph/config.json` — invisible in the file,
 * invisible in the app, indistinguishable from "the config is not being read".
 * It now sits BELOW it, and warns whenever it is what answered.
 *
 * Not removed outright, because for one real configuration it was the only
 * answer: a self-hosted deployment (custom API base) with the URL only in the
 * environment. Dropping the lane made that listener refuse to start, and on the
 * `zeph cc` autostart path its stderr goes to the log file, so the machine
 * would just vanish from the app — the very failure this change exists to end.
 */
export type WsUrlSource = 'flag' | 'config' | 'env-deprecated' | 'default';

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

    if (config.wsUrl) return { url: config.wsUrl, source: 'config' };

    // Below the config file, and above the built-in default: a machine that
    // only ever had the environment variable keeps the stage it was on instead
    // of being silently relocated to prod (or refusing to start).
    const legacyEnv = legacyWsEnv();
    if (legacyEnv) return { url: legacyEnv, source: 'env-deprecated' };

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

/**
 * A one-line notice for a machine that still exports `ZEPH_WS_URL`, or null.
 *
 * The variable is no longer read, and dropping it in silence would be the same
 * failure it caused: a value that appears to be in effect while something else
 * decides. Read only to say it is being ignored, never to use.
 */
export const legacyWsEnv = (env: NodeJS.ProcessEnv = process.env): string | null => {
    const value = env.ZEPH_WS_URL;
    // Same guard resolvedEnv applies: an unexpanded "${ZEPH_WS_URL}" from an
    // agent's env block is a placeholder, not a value.
    return value && !value.startsWith('${') ? value : null;
};

/**
 * What to tell a machine that still exports `ZEPH_WS_URL`, or null.
 *
 * Two different messages, because the two situations are not the same problem:
 * the config file now wins, so an export alongside it is dead weight, while an
 * export on its own is still holding the machine up and must not be deleted
 * before the value is moved.
 */
export const legacyWsEnvNotice = (
    config: { wsUrl?: string } = {},
    env: NodeJS.ProcessEnv = process.env,
): string | null => {
    if (!legacyWsEnv(env)) return null;
    return config.wsUrl
        ? 'zeph: ZEPH_WS_URL is set but ~/.zeph/config.json wins now — the export does nothing and can go.'
        : 'zeph: ZEPH_WS_URL is deprecated and will stop being read — move the value to "wsUrl" in ~/.zeph/config.json.';
};
