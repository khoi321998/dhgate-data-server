import { setTimeout as sleep } from 'node:timers/promises';

import { Impit } from 'impit';

/** Per-request budget. The browser path is the fallback, so a slow request should give up early. */
const HTTP_TIMEOUT_MS = 20_000;

/**
 * Requests per second, across every HTTP request the server makes from one IP — `0` = no limit.
 *
 * Akamai blocks an IP that asks too fast, and for ~10 minutes: ~85 requests/s from one IP got 403
 * "Access Denied" within seconds, and the block covered the browser path on that IP too; ~14/s
 * sequentially went through. Through the residential proxy every request has an IP of its own, so
 * no limit is needed there — 540 requests at the same pace went through without a block.
 */
let maxRequestsPerSecond = 0;
let nextSlotAt = 0;

export function setHttpRateLimit(requestsPerSecond: number): void {
    maxRequestsPerSecond = requestsPerSecond;
}

/** Wait for this request's turn under {@link setHttpRateLimit}. */
async function takeSlot(): Promise<void> {
    if (maxRequestsPerSecond <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, nextSlotAt);
    nextSlotAt = slot + 1000 / maxRequestsPerSecond;
    if (slot > now) await sleep(slot - now);
}

export interface HttpIdentity {
    /** Apify proxy URL (with its session), or none to go out directly. */
    proxyUrl?: string;
    /** A browser's own user agent, when the requests stand in for that browser; impit's Chrome one otherwise. */
    userAgent?: string;
    cookieHeader: string;
}

export type HttpResponse = Awaited<ReturnType<Impit['fetch']>>;

export interface HttpClient {
    fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<HttpResponse>;
}

/**
 * An HTTP client that looks like Chrome to DHGate: impit presents Chrome's TLS / HTTP2 fingerprint,
 * which Akamai checks — it answers Node's own `fetch` with 403 "Access Denied" on every page.
 *
 * A request the proxy drops (impit throws: connect, tunnel or read errors) is sent once more. A
 * refusal or a challenge is an answer, not a dropped request; callers judge those.
 */
export function createHttpClient(identity: HttpIdentity): HttpClient {
    const client = new Impit({
        browser: 'chrome',
        proxyUrl: identity.proxyUrl,
        timeout: HTTP_TIMEOUT_MS,
        headers: {
            ...(identity.userAgent ? { 'user-agent': identity.userAgent } : {}),
            'accept-language': 'en-US,en;q=0.9',
            cookie: identity.cookieHeader,
        },
    });
    return {
        fetch: async (url, init) => {
            await takeSlot();
            try {
                return await client.fetch(url, init);
            } catch {
                await takeSlot();
                return client.fetch(url, init);
            }
        },
    };
}

/** The cookies the browser path sets before its first navigation, for a request without a browser. */
export function localeCookieHeader(shipCountry: string): string {
    return `language=en; b2b_ship_country=${shipCountry}; intl_currency=USD`;
}

/**
 * One line for the log. impit puts the cause after a generic first line ("The internal HTTP library
 * has thrown an error:"), in a multi-line Rust debug dump, so the first line alone says nothing.
 */
export function describeHttpError(error: unknown): string {
    return ((error as Error).message ?? String(error)).replace(/\s+/g, ' ').trim().slice(0, 300);
}
