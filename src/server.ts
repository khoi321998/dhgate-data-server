import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// For more information, see https://crawlee.dev
import type { PlaywrightCrawlingContext, Request } from '@crawlee/playwright';
import { Configuration, PlaywrightCrawler, purgeDefaultStorages } from '@crawlee/playwright';
// For more information, see https://docs.apify.com/sdk/js
import { Actor } from 'apify';
// Drop-in Playwright fork with the automation leaks patched out — see `launcher` below.
import { chromium as patchrightChromium } from 'patchright';
import type { BrowserType } from 'playwright';

import { CRASH_GUARD, intEnv, MAX_REQUEST_RETRIES, PARALLEL_SELLER, PRODUCT_OVER_HTTP } from './config.js';
// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// note that we need to use `.js` even when inside TS files
import type { CaptureMode, ProductSellerResponse } from './dto/index.js';
import { scrapeOverHttp } from './http-path.js';
import type { Job } from './jobs.js';
import { createJob, describeJob, dropJob, isOrphan, jobCount, jobOf } from './jobs.js';
import { log, runWithJobPrefix } from './logger.js';
import { auditRow, pushItem } from './push.js';
import { createRouter, DEFAULT_MODE, LABELS, modeOf } from './routes.js';
import { blockUnneededRequests } from './utils/blocking.js';
import { chooseChrome } from './utils/browser.js';
import { passCloudflare } from './utils/cloudflare.js';
import { DEBUG_PAGE_ERRORS, recordPageErrors } from './utils/debug.js';
import { emptyResponse } from './utils/defaults.js';
import { BlockedError, describeHttpError, setHttpRateLimit } from './utils/http.js';
import { DEFAULT_SHIP_COUNTRY, extractDhgateShipCountry, normalizeDhgateHost } from './utils/parse.js';
import { startQueuedNow } from './utils/pool.js';
import { describeProxy, proxyChoiceFromEnv } from './utils/proxy.js';
import { reportedUrl } from './utils/request.js';
import { logPageErrors } from './utils/tabs.js';

/**
 * DHGate scraping HTTP server: keeps one crawler (and its browser) warm and scrapes one URL per request.
 *
 *   POST /scrape  { "url": "https://www.dhgate.com/...", "mode"?: "...", "transactionId"?: "..." }
 *                 -> the scraped row + timing (requires header x-api-key)
 *   GET  /        -> health / status (no auth, for health checks)
 *
 * Env vars: API_KEY (required), PORT (8080), MAX_CONCURRENCY (4), MAX_QUEUE (100), MAX_REQUEST_RETRIES (3),
 * JOB_TIMEOUT_SECS (900), PARALLEL_SELLER (true), APIFY_PROXY_GROUPS (empty = no proxy, DATACENTER or
 * RESIDENTIAL) + APIFY_PROXY_PASSWORD, APIFY_PROXY_COUNTRY (US).
 *
 * Every request — and every retry of it — runs in a browser of its own, launched for it on a new session
 * (so a new proxy IP) and closed after it. A `product_and_seller` request opens its store page in a
 * second tab of that browser.
 */

const API_KEY = process.env.API_KEY ?? '';
if (API_KEY.length < 16) throw new Error('Env var API_KEY is required and must be at least 16 characters.');

const PORT = intEnv('PORT', 8080);
// Requests scraped at once, each in its own browser. Requests beyond this wait in the crawler's queue, in
// FIFO order.
const MAX_CONCURRENCY = intEnv('MAX_CONCURRENCY', 4);
// Requests running or waiting. Beyond this the server answers 503.
const MAX_QUEUE = intEnv('MAX_QUEUE', 100);
// A request still without a row after this long is answered with an error, so a caller never hangs forever.
const JOB_TIMEOUT_MS = intEnv('JOB_TIMEOUT_SECS', 900) * 1000;
// A request's handler covers its product page and — in a parallel tab — its store page with the About and
// Review tabs, which through the proxy can take well over Crawlee's default 60 s.
const REQUEST_HANDLER_TIMEOUT_SECS = 180;
const MAX_BODY_BYTES = 64 * 1024;
const MEMORY_LOG_INTERVAL_MS = 10 * 60_000;
// A finished job's queue entries (which hold the scraped product) are deleted after this delay, so memory
// does not grow with every request. The delay lets the crawler mark the request handled first.
const QUEUE_CLEANUP_DELAY_MS = 60_000;

const VALID_MODES: readonly CaptureMode[] = ['product_only', 'product_and_seller', 'seller_only'];

// --- Proxy: Apify is used only for its residential proxy (needs APIFY_PROXY_PASSWORD, no Actor.init). ---

// APIFY_PROXY_GROUPS: empty = no proxy, DATACENTER or RESIDENTIAL — see utils/proxy.ts.
const proxyChoice = proxyChoiceFromEnv(process.env);

// Without a proxy we do not even ask the SDK. With one, `undefined` back from here is a problem
// rather than a choice — Apify Proxy was asked for and could not be reached — so the server refuses
// to start instead of hitting DHGate from its own IP.
const proxyConfiguration = proxyChoice.enabled ? await Actor.createProxyConfiguration(proxyChoice.settings) : undefined;
if (proxyConfiguration) {
    log.info(`Proxy: ${describeProxy(proxyChoice)}`);
} else if (!proxyChoice.enabled) {
    log.info('Proxy: none — APIFY_PROXY_GROUPS is empty; hitting DHGate from this machine’s own IP');
} else {
    throw new Error('Failed to create Apify proxy configuration. Is APIFY_PROXY_PASSWORD set?');
}

// HTTP requests per second (the HTTP path, and store pages fetched over HTTP), 0 = no limit. Akamai
// blocks an IP that asks too fast for ~10 minutes — the browser path with it — so from one IP (no
// proxy, or a datacenter IP) they are paced; through the residential proxy each request has its own.
const HTTP_MAX_RPS = intEnv('HTTP_MAX_RPS', proxyChoice.kind === 'RESIDENTIAL' ? 0 : 5, 0);
setHttpRateLimit(HTTP_MAX_RPS);

// New proxy sessions (new IPs) the HTTP path tries when its session is refused — a 403 / 429, Akamai's
// "Access Denied", a Cloudflare challenge, a dropped connection — before it sends the job to the browser.
// A page it cannot read is not retried: a new IP serves the same page. Without a proxy there is no IP to change.
const HTTP_SESSION_RETRIES = intEnv('HTTP_SESSION_RETRIES', 3, 0);

// Which browser binary we drive is the biggest single factor in how often Cloudflare challenges us,
// so it is resolved and logged up front rather than buried in the launch options. See utils/browser.ts.
const chrome = chooseChrome();
log[chrome.useChrome ? 'info' : 'warning'](`Browser: ${chrome.description}`);

// Force DHGate to render in English and price in USD regardless of the (proxy) IP
// geolocation. Ship-to is per request — see `shipCountry` — so a URL taken from a regional
// storefront still gets that region's shipping/availability, just described in English.
// Keeping the currency fixed at USD makes rows comparable across countries; flip
// `intl_currency` here if you would rather capture each region's local currency.
const localeCookies = (shipCountry: string) => [
    { name: 'language', value: 'en', domain: '.dhgate.com', path: '/' },
    { name: 'b2b_ship_country', value: shipCountry, domain: '.dhgate.com', path: '/' },
    { name: 'intl_currency', value: 'USD', domain: '.dhgate.com', path: '/' },
];

// How long to wait after a failed attempt before Crawlee retries the request.
// Crawlee retries immediately by default, which hammers DHGate right when it is
// already unhappy with us; a short pause makes failures easier to observe while testing.
const RETRY_DELAY_MILLIS = 5_000;

/** Run `fn` with the job's transactionId (or url, without one) on every log line, when the request belongs to a job. */
async function withJobLog<T>(request: Request, fn: () => Promise<T>): Promise<T> {
    const job = jobOf(request);
    return job ? runWithJobPrefix(describeJob(job), fn) : fn();
}

/**
 * The crawler, with every request of a job run in that job's log context. `_runRequestHandler` covers
 * the navigation hooks, the Cloudflare wait and the route handler — everything that happens on the page.
 */
class DhgateCrawler extends PlaywrightCrawler {
    protected override async _runRequestHandler(context: PlaywrightCrawlingContext): Promise<void> {
        const { request } = context;
        // The caller already got a timeout response: don't spend a browser page on it.
        if (isOrphan(request)) {
            log.info(`Skipping ${request.url}: its request already timed out`);
            return;
        }
        const job = jobOf(request);
        if (job) {
            job.startedAt ??= Date.now();
            if (request.id) job.requestIds.add(request.id);
        }
        // eslint-disable-next-line no-underscore-dangle
        await withJobLog(request, async () => super._runRequestHandler(context));
    }
}

// The request queue only lives as long as the process: a request is answered over HTTP or not at all,
// so nothing is written to ./storage.
const crawlerConfig = new Configuration({ persistStorage: false });

const crawler = new DhgateCrawler(
    {
        // Proxy is configurable and defaults to Apify RESIDENTIAL/US. Note what it does and does not
        // fix: the earlier measurement still holds — the same IP that gets challenged in an automated
        // browser answers 200 to curl and to a real Chrome, so the challenge is a *fingerprint*
        // trigger, not an IP ban, and a proxy alone will not make it disappear. What a residential US
        // exit buys is a gentler Cloudflare threat score (fewer interactive "Verify you are human"
        // variants) and a fresh IP per retired session. See utils/cloudflare.ts.
        proxyConfiguration,
        // The server feeds the crawler for as long as it runs: an empty queue means "wait", not "done".
        keepAlive: true,
        // Fixed, not autoscaled: Crawlee's pool starts at 1 page and adds one every 10 s while the machine
        // looks idle (and drops back when headed Chrome spikes the CPU), so after every start — and under
        // load — requests and a product's parallel store page ran one at a time. The operator sizes
        // MAX_CONCURRENCY to the machine instead.
        minConcurrency: MAX_CONCURRENCY,
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestRetries: MAX_REQUEST_RETRIES,
        requestHandlerTimeoutSecs: REQUEST_HANDLER_TIMEOUT_SECS,
        // Nothing carries over from one request to the next: each browser starts on a fresh session
        // with no cookies.
        persistCookiesPerSession: false,
        // Crawlee treats 403 as "blocked" and throws in its own response handler, before any of our
        // code — including the challenge wait below — gets a say. But on DHGate every first hit is a
        // 403: that is what the Cloudflare interstitial is served with, and it clears itself seconds
        // later. So 403 is taken off this list and judged after the wait instead, by `detectBlocked`
        // in the handlers, which by then knows whether the challenge actually passed.
        sessionPoolOptions: {
            blockedStatusCodes: [401, 429],
            // A browser is launched with a session and keeps it, so a session used once is never handed
            // to the next browser: each request (and each retry) gets a new session, so a new proxy IP.
            sessionOptions: { maxUsageCount: 1 },
        },
        requestHandler: createRouter(),
        // Runs between a failed attempt and the next one (not after the last retry —
        // that is `failedRequestHandler`), so awaiting here delays only the retry.
        errorHandler: async ({ request }, error) =>
            withJobLog(request, async () => {
                log.warning(
                    `Attempt ${request.retryCount + 1} failed for ${request.url}: ${(error as Error).message}. ` +
                        `Retrying in ${RETRY_DELAY_MILLIS / 1000}s.`,
                );
                await sleep(RETRY_DELAY_MILLIS);
            }),
        // Last stop after every retry is spent. Without this the URL would simply vanish from the
        // output, leaving the caller unable to tell "we never managed to load it" from "we never
        // tried" — so it gets a row like any other, marked FETCH_FAILED.
        failedRequestHandler: async (ctx, error) =>
            withJobLog(ctx.request, async () => {
                const { request } = ctx;
                // Report the caller's original URL, not the normalized one we actually navigated to.
                const url = reportedUrl(request);
                const row = emptyResponse(url, modeOf(request));
                row.success = false;
                row.errorCode = 'FETCH_FAILED';
                row.errorMessage = `gave up after ${request.retryCount} retries: ${(error as Error).message}`;
                const job = jobOf(request);
                if (job) job.statusCode = ctx.response?.status() ?? null;
                await pushItem(ctx, row);
            }),
        // Headed, and not negotiable: Playwright's bundled Chromium in headless mode never clears
        // DHGate's Cloudflare challenge — verified against a live product URL, it sat on the
        // interstitial for the full 30s. Headed, the same browser clears it in about five seconds.
        headless: true,
        preNavigationHooks: [
            async ({ page, request }, gotoOptions) => {
                // Crawlee waits for `load` by default, which DHGate's error pages never fire: a dead
                // product/store URL burnt the full 60s navigation timeout, three times over, before
                // the handler ever got to say "not found". `domcontentloaded` fires on those pages in
                // about a second, and the extractors all gate on their own selectors anyway — none of
                // them needs images and trackers to have finished loading.
                // eslint-disable-next-line no-param-reassign -- Crawlee's hook contract is to mutate it
                gotoOptions.waitUntil = 'domcontentloaded';
                // Set the locale cookies before the first navigation so the very first render is
                // already English / USD and shipping to the right country. Browser contexts are
                // reused across requests, so this re-writes `b2b_ship_country` every time rather
                // than letting the previous request's country leak into this one.
                const { shipCountry = DEFAULT_SHIP_COUNTRY } = request.userData as { shipCountry?: string };
                await page.context().addCookies(localeCookies(shipCountry));
                // Each attempt has a page (and browser) of its own, so this is registered once per page.
                logPageErrors(page, request.label ?? 'page');
                // Images, video, fonts and trackers never go out through the proxy — see utils/blocking.ts.
                await blockUnneededRequests(page);
                // DEBUG_PAGE_ERRORS: record the page's JavaScript errors, logged if it crashes.
                // (Its recorder is an init script too, so it also does what CRASH_GUARD does.)
                if (DEBUG_PAGE_ERRORS) await recordPageErrors(page);
                // CRASH_GUARD: an init script that does nothing keeps DHGate's app from crashing — see config.ts.
                else if (CRASH_GUARD) await page.addInitScript('void 0;');
            },
        ],
        postNavigationHooks: [
            // DHGate serves a Cloudflare "Just a moment…" interstitial (HTTP 403) in front of its
            // pages. It has to be dealt with here, before any handler runs: the handlers' `detectBlocked`
            // sees the 403 and throws instantly, burning all three retries on a challenge that was
            // about to pass. See utils/cloudflare.ts for the two ways past it.
            passCloudflare,
        ],
        browserPoolOptions: {
            // Crawlee injects a generated fingerprint (usually a Windows Chrome UA and matching JS
            // shims) by default. That helps a bundled Chromium and actively hurts a real one: the
            // spoofed navigator says Windows while the platform APIs, fonts and GPU strings underneath
            // say Linux, and *that mismatch* is precisely what Cloudflare grades. It is also injected
            // with `addInitScript`, which is one of the things Patchright exists to keep off the page.
            // A real Chrome's own consistent fingerprint beats a fabricated one.
            useFingerprints: !chrome.useChrome,
            // One browser per request: a page never shares a browser, and a browser is retired after its
            // page — closed once that page is — so the next request or retry launches a new one. A page
            // that crashed, got challenged or broke DHGate's app cannot leak into another request.
            // (The store-page tab a request opens itself is not one of Crawlee's pages.)
            maxOpenPagesPerBrowser: 1,
            retireBrowserAfterPageCount: 1,
            postLaunchHooks: [
                (_pageId, browserController) => {
                    const session = browserController.launchContext.session as { id?: string } | undefined;
                    log.info(`Launched a new browser (session ${session?.id ?? 'none'}, ${describeBrowsers()})`);
                },
            ],
            prePageCreateHooks: [
                (_pageId, _controller, pageOptions) => {
                    // Playwright's default 1280x720 viewport is applied through the CDP call
                    // `Emulation.setDeviceMetricsOverride`, and a page whose metrics are overridden does
                    // not look like a window someone opened. `null` means "whatever the real window is",
                    // which is what Patchright's own recommended configuration asks for. Click positions
                    // are measured off the live DOM, so nothing downstream depends on a fixed size.
                    // BrowserPool's hook contract is to mutate the options object it hands in; there is
                    // no return value it would read, so the reassignment is the API, not a slip.
                    // eslint-disable-next-line no-param-reassign
                    if (pageOptions) pageOptions.viewport = null;
                },
            ],
        },
        launchContext: {
            // Patchright is a drop-in Playwright fork that closes the leaks vanilla Playwright opens in
            // the browser it drives — chiefly the `Runtime.Enable` CDP call, which Cloudflare and
            // DataDome both watch for. Everything measurable had already been ruled out on the platform
            // (real Chrome, residential IP, a click landing 1px off the checkbox centre, healthy CPU)
            // and the challenge still refused, which leaves how the browser is driven rather than what
            // it is. Crawlee only needs a launcher with Playwright's shape, so this is a one-line swap.
            // The cast bridges a *type* gap, not a behavioural one: `patchright-core` tracks Playwright
            // 1.62 while this project is pinned to 1.60 to match the Docker base image, so its `Locator`
            // declares methods (`waitForFunction`) that 1.60's does not, and the two structural types
            // refuse to unify. The runtime API Crawlee actually calls — `launch`, `name`, `connect` —
            // is identical, which is the whole premise of a drop-in fork. Upgrading Playwright instead
            // would break `check-playwright-version.mjs` against the 1.60 base image.
            launcher: patchrightChromium as unknown as BrowserType,
            // The real Google Chrome, not a bundled Chromium — Patchright's documented configuration
            // asks for the branded build too. `executablePath` is the one utils/browser.ts actually
            // probed for, so Crawlee does not have to guess a second time.
            useChrome: chrome.useChrome,
            launchOptions: {
                executablePath: chrome.executablePath,
                args: [
                    '--disable-gpu', // Mitigates the "crashing GPU process" issue in Docker containers
                ],
                // Deliberately absent: `--disable-blink-features=AutomationControlled`. Patchright
                // handles `navigator.webdriver` at a lower level, and the flag is itself a deviation
                // from how a real Chrome is started — which is one of the things Patchright patches out
                // of the command line. Adding it back would undo part of what it is here to do.
            },
        },
    },
    crawlerConfig,
);

// --- Load: MAX_CONCURRENCY pages run (crawler), the rest wait in its queue; MAX_QUEUE caps running + waiting. ---

let inProgress = 0;

/** Browsers in use / retired but still closing, for logs and the health check. */
function browserStats() {
    // Read lazily: the pool exists from construction, but this is also called from its own launch hook.
    const pool = crawler.browserPool;
    return { active: pool.activeBrowserControllers.size, retired: pool.retiredBrowserControllers.size };
}

function describeBrowsers(): string {
    const { active, retired } = browserStats();
    return `browsers: ${active} active, ${retired} retiring`;
}

/** Current load, for logs. */
function describeLoad(): string {
    return `in progress: ${inProgress}/${MAX_QUEUE}, max concurrency: ${MAX_CONCURRENCY}, ${describeBrowsers()}`;
}

// --- HTTP helpers ---

const API_KEY_BUFFER = Buffer.from(API_KEY);

function isAuthorized(req: IncomingMessage): boolean {
    const provided = req.headers['x-api-key'];
    if (typeof provided !== 'string') return false;
    const providedBuffer = Buffer.from(provided);
    // Constant-time comparison so the key can't be guessed from response timing.
    return providedBuffer.length === API_KEY_BUFFER.length && timingSafeEqual(providedBuffer, API_KEY_BUFFER);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

const NO_TIMING = { queueMs: 0, processMs: 0, totalMs: 0 };

/** Every failed /scrape response has the same shape, so the backend can read url / error / statusCode / timing. */
function sendFailed(
    res: ServerResponse,
    httpStatus: number,
    body: { url?: string | null; error: string; statusCode?: number | null; timing?: typeof NO_TIMING },
) {
    const { url = null, error, statusCode = null, timing: t = NO_TIMING } = body;
    sendJson(res, httpStatus, { status: 'failed', url, error, statusCode, timing: t });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
        chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** A DHGate http(s) url (any regional subdomain), or null. */
function parseTargetUrl(body: unknown): string | null {
    const raw = (body as { url?: unknown })?.url;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const url = new URL(raw.trim());
        const host = url.hostname.toLowerCase();
        const isDhgate = host === 'dhgate.com' || host.endsWith('.dhgate.com');
        return (url.protocol === 'https:' || url.protocol === 'http:') && isDhgate ? url.href : null;
    } catch {
        return null;
    }
}

/** Optional `mode`: the default when absent, null when invalid. */
function parseMode(body: unknown): CaptureMode | null {
    const mode = (body as { mode?: unknown })?.mode;
    if (mode === undefined || mode === null) return DEFAULT_MODE;
    return VALID_MODES.includes(mode as CaptureMode) ? (mode as CaptureMode) : null;
}

const TRANSACTION_ID_PATTERN = /^[\w.:-]{1,100}$/;

/** Optional `transactionId`: undefined when absent, null when invalid. Restricted characters keep log lines intact. */
function parseTransactionId(body: unknown): string | undefined | null {
    const id = (body as { transactionId?: unknown })?.transactionId;
    if (id === undefined || id === null) return undefined;
    return typeof id === 'string' && TRANSACTION_ID_PATTERN.test(id) ? id : null;
}

function secs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function timing(job: Job) {
    const now = Date.now();
    const startedAt = job.startedAt ?? now;
    return { queueMs: startedAt - job.enqueuedAt, processMs: now - startedAt, totalMs: now - job.enqueuedAt };
}

/** The crawler request for a job — same mapping the Actor applied to each start URL. */
function startRequest(job: Job) {
    // `seller_only` calls start from seller URLs; the other two modes start from
    // product URLs. Route each start URL to the matching handler accordingly.
    const label = job.mode === 'seller_only' ? LABELS.SELLER : LABELS.PRODUCT;
    // Regional hosts (es./fr./…) are rewritten to www: they serve the same product but in the
    // local language — which the `language` cookie cannot override — and each one carries its own
    // Cloudflare challenge. The regional context is preserved rather than discarded: the original
    // subdomain becomes the ship-to country, applied per request in the pre-navigation hook.
    const url = normalizeDhgateHost(job.url);
    const shipCountry = extractDhgateShipCountry(job.url);
    if (url !== job.url) log.info(`Normalized ${job.url} -> ${url} (ship to ${shipCountry})`);
    return {
        url,
        label,
        // Unique per call, so the same URL asked for twice is crawled twice instead of deduped.
        uniqueKey: job.id,
        userData: { shipCountry, inputUrl: job.url, jobId: job.id, mode: job.mode },
    };
}

/** The job's row, or a timeout error once JOB_TIMEOUT_MS has passed without one. */
async function waitForRow(job: Job): Promise<ProductSellerResponse> {
    const ac = new AbortController();
    try {
        return await Promise.race([
            job.result,
            sleep(JOB_TIMEOUT_MS, undefined, { signal: ac.signal }).then(() => {
                throw new Error(`No result after ${secs(JOB_TIMEOUT_MS)} (JOB_TIMEOUT_SECS).`);
            }),
        ]);
    } finally {
        ac.abort();
    }
}

/**
 * The job scraped without a browser (see `scrapeOverHttp`), or `null` when the HTTP path gave up and the
 * job should go to the browser, as before. A refused session is retried on a new one (a new proxy IP)
 * up to `HTTP_SESSION_RETRIES` times; anything else gives up at once. Every attempt is logged.
 */
async function scrapeJobOverHttp(job: Job): Promise<ProductSellerResponse | null> {
    const startedAt = Date.now();
    const attempts = 1 + (proxyConfiguration ? HTTP_SESSION_RETRIES : 0);
    const history: string[] = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const attemptStartedAt = Date.now();
        // A proxy session of its own, as the browser path's: one IP for every request of the attempt.
        const session = `http_${job.id.replace(/-/g, '')}_${attempt}`;
        const proxyUrl = await proxyConfiguration?.newUrl(session);
        const where = proxyUrl ? `session ${session}` : 'no proxy';
        log.info(`HTTP attempt ${attempt}/${attempts} (${where})`);
        const outcome = await scrapeOverHttp(job.url, job.mode, proxyUrl, log).catch((error: unknown) => ({
            fallback: describeHttpError(error),
            blocked: error instanceof BlockedError,
        }));
        const took = secs(Date.now() - attemptStartedAt);

        if ('fallback' in outcome) {
            history.push(`#${attempt} ${outcome.blocked ? 'blocked' : 'failed'} in ${took}: ${outcome.fallback}`);
            if (outcome.blocked && attempt < attempts) {
                log.warning(
                    `HTTP attempt ${attempt}/${attempts} blocked after ${took} (${where}): ${outcome.fallback} — retrying on a new session`,
                );
                continue;
            }
            let why = 'not a block, a new session would not help';
            if (outcome.blocked)
                why = proxyConfiguration
                    ? `still blocked after ${attempts} sessions`
                    : 'blocked, and no proxy to change the IP';
            log.warning(
                `HTTP attempt ${attempt}/${attempts} ${outcome.blocked ? 'blocked' : 'failed'} after ${took} (${where}): ${outcome.fallback}`,
            );
            log.warning(
                `HTTP path gave up after ${secs(Date.now() - startedAt)} (${why}) — scraping in a browser. Attempts: ${history.join(' | ')}`,
            );
            return null;
        }

        auditRow(outcome.row, log);
        // Only a field no live page lacks (id, title, price, seller id / name) sends the job to the browser:
        // without it the page was not read. A missing `warning` field (specifications, delivery, …) can be
        // genuinely absent from the listing, and the browser would find it empty too — so it stays as is.
        // Not retried: the page was served, so a new IP would get the same one.
        if (outcome.row.extraction.status === 'broken') {
            history.push(`#${attempt} failed in ${took}: missing ${outcome.row.extraction.missingFields.join(', ')}`);
            log.warning(
                `HTTP path gave up after ${secs(Date.now() - startedAt)} (not a block, a new session would not help) — scraping in a browser. Attempts: ${history.join(' | ')}`,
            );
            return null;
        }
        const earlier = history.length > 0 ? `, after ${history.length} blocked: ${history.join(' | ')}` : '';
        log.info(
            `Scraped over HTTP in ${secs(Date.now() - startedAt)} (attempt ${attempt}/${attempts}, ${where}${earlier})`,
        );
        return outcome.row;
    }
    return null;
}

/** Drop the job's finished queue entries — they hold the scraped row — once the crawler is done with them. */
function scheduleQueueCleanup(job: Job) {
    setTimeout(() => {
        const queue = crawler.requestQueue;
        if (!queue) return;
        for (const id of job.requestIds) {
            queue.client.deleteRequest(id).catch((error: Error) => {
                log.debug(`Could not delete queue entry ${id}: ${error.message}`);
            });
        }
    }, QUEUE_CLEANUP_DELAY_MS).unref();
}

async function handleScrape(req: IncomingMessage, res: ServerResponse) {
    let body: unknown;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        sendFailed(res, 400, { error: `Invalid JSON body: ${(error as Error).message}` });
        return;
    }

    const url = parseTargetUrl(body);
    if (!url) {
        sendFailed(res, 400, {
            error: 'Body must be JSON like {"url": "https://www.dhgate.com/product/..."} with a dhgate.com http(s) url.',
        });
        return;
    }

    const mode = parseMode(body);
    if (!mode) {
        sendFailed(res, 400, { url, error: `mode must be one of: ${VALID_MODES.join(', ')}` });
        return;
    }

    const transactionId = parseTransactionId(body);
    if (transactionId === null) {
        sendFailed(res, 400, { url, error: 'transactionId must be a string of 1-100 letters, digits or . _ : -' });
        return;
    }

    const described = describeJob({ url, transactionId });
    if (inProgress >= MAX_QUEUE) {
        log.warning(`Rejected ${described}: server busy (${describeLoad()}, MAX_QUEUE=${MAX_QUEUE})`);
        sendFailed(res, 503, {
            url,
            error: `Server busy: ${inProgress} requests in progress (MAX_QUEUE=${MAX_QUEUE}).`,
        });
        return;
    }

    inProgress++;
    const job = createJob({ id: randomUUID(), url, transactionId, mode });
    try {
        log.info(`Received ${described}${transactionId ? ` ${url}` : ''} (mode: ${mode}, ${describeLoad()})`);
        // The HTTP path counts as the job's processing time, not its queue time.
        if (PRODUCT_OVER_HTTP) job.startedAt = Date.now();
        let row = PRODUCT_OVER_HTTP ? await runWithJobPrefix(described, async () => scrapeJobOverHttp(job)) : null;
        if (!row) {
            await runWithJobPrefix(described, async () => crawler.addRequests([startRequest(job)]));
            // Start it now rather than on the pool's next check — see `startQueuedNow` in utils/pool.ts.
            startQueuedNow(crawler);
            row = await waitForRow(job);
        }
        const t = timing(job);
        // Nothing scraped at all: the page never loaded through every retry. A row that kept a product
        // (seller page failed) or says "not found" is still an answer about the url, so it is a 200.
        if (row.errorCode === 'FETCH_FAILED' && !row.product && !row.seller) {
            throw new Error(row.errorMessage ?? 'Failed to fetch the page.');
        }
        log.info(
            `Scraped ${described} (success: ${row.success}${row.errorCode ? `, ${row.errorCode}` : ''}, extraction: ${row.extraction.status}) in ${secs(t.totalMs)} (queue ${secs(t.queueMs)}, scrape ${secs(t.processMs)})`,
        );
        sendJson(res, 200, { status: 'success', ...row, timing: t });
    } catch (error) {
        const t = timing(job);
        const statusCode = job.statusCode ?? null;
        const message = (error as Error).message.replace(/\s*\n\s*/g, ' ').trim();
        log.warning(
            `Scrape failed for ${described} (HTTP ${statusCode ?? 'no response'}) after ${secs(t.totalMs)}: ${message}`,
        );
        sendFailed(res, 502, { url, error: message, statusCode, timing: t });
    } finally {
        dropJob(job.id);
        scheduleQueueCleanup(job);
        inProgress--;
    }
}

setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    log.info(`Memory: Node RSS ${rssMb} MB, ${describeLoad()}`);
}, MEMORY_LOG_INTERVAL_MS).unref();

const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === '/') {
        sendJson(res, 200, {
            status: 'ok',
            maxConcurrency: MAX_CONCURRENCY,
            maxQueue: MAX_QUEUE,
            inProgress,
            jobs: jobCount(),
            browsers: browserStats(),
        });
        return;
    }

    if (req.method === 'POST' && path === '/scrape') {
        if (!isAuthorized(req)) {
            sendFailed(res, 401, { error: 'Missing or invalid x-api-key header.' });
            return;
        }
        handleScrape(req, res).catch((error) => {
            log.exception(error as Error, 'Unhandled error while handling /scrape');
            if (!res.headersSent) sendFailed(res, 500, { error: 'Internal server error.' });
        });
        return;
    }

    sendJson(res, 404, { error: 'Not found. Use POST /scrape or GET /.' });
});

// --- Crawler lifecycle: one run for the life of the process. ---

let shuttingDown = false;

// Purged up front (run() does it too, but only after its first await): a request added before that
// would otherwise be wiped with the queue.
await purgeDefaultStorages({ onlyPurgeOnce: true, client: crawlerConfig.getStorageClient(), config: crawlerConfig });
crawler
    .run()
    .then(() => {
        if (shuttingDown) return;
        log.error('Crawler stopped unexpectedly, exiting so the container restarts.');
        process.exit(1);
    })
    .catch((error) => {
        log.exception(error as Error, 'Crawler crashed, exiting so the container restarts.');
        process.exit(1);
    });

server.listen(PORT, () => {
    log.info(`DHGate scraping server listening on port ${PORT}`);
    // Never log secrets: API_KEY and APIFY_PROXY_PASSWORD are reported only as set / not set.
    log.info('Server config', {
        PORT,
        MAX_CONCURRENCY,
        MAX_QUEUE,
        MAX_REQUEST_RETRIES,
        JOB_TIMEOUT_SECS: JOB_TIMEOUT_MS / 1000,
        PARALLEL_SELLER,
        PRODUCT_OVER_HTTP,
        HTTP_MAX_RPS,
        HTTP_SESSION_RETRIES,
        DEBUG_PAGE_ERRORS,
        CRASH_GUARD,
        APIFY_PROXY: describeProxy(proxyChoice),
        APIFY_PROXY_PASSWORD: process.env.APIFY_PROXY_PASSWORD ? 'set' : 'not set',
        API_KEY: 'set',
    });
});

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down.`);
    server.close();
    await crawler.teardown();
    process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        shutdown(signal).catch((error) => {
            log.exception(error as Error, 'Error during shutdown');
            process.exit(1);
        });
    });
}
