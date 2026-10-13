/** Settings read from the environment that more than the server entry point needs. */

export function intEnv(name: string, fallback: number, min = 1): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min)
        throw new Error(`Env var ${name} must be an integer >= ${min}, got "${raw}".`);
    return value;
}

/**
 * Retries per request after the first attempt. Each one runs in a new browser on a new session, so a
 * new proxy IP. The product handler reads it to know whether a failed store page can still be retried.
 */
export const MAX_REQUEST_RETRIES = intEnv('MAX_REQUEST_RETRIES', 3, 0);

/**
 * `STORE_OVER_HTTP=false` always scrapes the store pages in a browser tab. On by default: they are
 * fetched over HTTP (as the request's browser) and only opened in a tab when that fails.
 */
export const STORE_OVER_HTTP = process.env.STORE_OVER_HTTP !== 'false';

/**
 * `CRASH_GUARD=false` turns off the empty init script the product page gets. On by default.
 *
 * DHGate's Next.js product page crashes now and then into "Application error: a client-side exception
 * has occurred" a few seconds after load — with or without a proxy, ~17% of attempts in a 40-request
 * run. An init script, even one that does nothing, stopped it: 0 crashes in 40 requests run
 * interleaved with those 40. What changes is how Patchright delivers the page (it routes the document
 * to put the script in), which evidently sidesteps a timing race in DHGate's app; the error itself is
 * DHGate's and was never seen. The trade-off: an injected script is the kind of trace bot detection
 * can look for, which is why it can be turned off.
 */
export const CRASH_GUARD = process.env.CRASH_GUARD !== 'false';

/** `PARALLEL_SELLER=false` opens the store page only after the product page is done. */
export const PARALLEL_SELLER = process.env.PARALLEL_SELLER !== 'false';

/**
 * `PRODUCT_OVER_HTTP=false` always scrapes in a browser. On by default: a request is first scraped
 * over HTTP — the product page, its APIs and the store pages, no browser — and only goes to the
 * browser when that gives up (a refusal, a challenge, data it cannot read). See `src/http-path.ts`.
 */
export const PRODUCT_OVER_HTTP = process.env.PRODUCT_OVER_HTTP !== 'false';
