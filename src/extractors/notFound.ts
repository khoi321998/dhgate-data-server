import type { Page } from 'playwright';

import { CHALLENGE_TITLE } from '../utils/cloudflare.js';

/**
 * Is this the page we asked for, or a dead end?
 *
 * Both handlers open a URL that came from outside — a start URL the user typed, or a store link
 * scraped off a PDP — so both can land somewhere that holds no data. Three outcomes, and telling
 * them apart is the whole point of this module:
 *
 * - **gone** — the listing/store does not exist. Push an error row and move on; retrying a 410
 *   just spends the same minute again.
 * - **blocked** — DHGate is refusing us (anti-bot, or its backend is unwell). Throw, so Crawlee
 *   retries with a fresh session. Recording this as "not found" would quietly turn an
 *   infrastructure problem into "the catalogue shrank".
 * - **fine** — let the extractors run.
 *
 * Both checks must happen before any extractor: every one of them waits on a DOM that a dead page
 * will never mount, and the seller extractors additionally click store tabs that are not there —
 * so a single bad URL costs minutes of timeouts and ends in a row of nulls indistinguishable from
 * selector rot.
 */

/** The page kinds we can be pointed at, and the URL shape each one must keep. */
const URL_SHAPE = {
    /** `/product/<slug>/<id>.html` */
    product: /\/product\/.*\/\d+\.html/,
    /** `/store/<tab>/<id>.html` — the tab segment varies, `/store/` does not. */
    seller: /\/store\//,
} as const;

export type PageKind = keyof typeof URL_SHAPE;

/**
 * Statuses that mean the page is gone for good. Verified against live DHGate: an unknown product
 * id returns `410 Gone`, an unknown store id `404` (both 200 when alive).
 */
const GONE_STATUSES = new Set([404, 410]);

/** Statuses that mean "not now" rather than "not ever" — worth another attempt on a new session. */
const BLOCKED_STATUSES = new Set([401, 403, 429]);

/**
 * Detect a refusal: anti-bot (401/403/429, DHGate's "Access Denied" page, or a Cloudflare
 * challenge that never cleared) and 5xx, which DHGate serves to a browser for URLs its CDN answers
 * with a clean 404 — so a 5xx here is not evidence of anything about the item.
 *
 * Pass the status through `effectiveStatus` first. Cloudflare's interstitial *is* a 403, and the
 * real page it hands us afterwards arrives on a navigation Crawlee never records — so the raw
 * `ctx.response` status would condemn a perfectly good product page.
 *
 * Returns the reason, for the caller to throw with; `null` when the response looks usable.
 */
export async function detectBlocked(page: Page, status?: number): Promise<string | null> {
    if (status != null && (BLOCKED_STATUSES.has(status) || status >= 500)) {
        return `DHGate answered HTTP ${status}`;
    }
    const title = await page.title().catch(() => '');
    if (/access denied/i.test(title)) return 'DHGate served its "Access Denied" page';
    // The post-navigation hook already waited this out; still being here means it never cleared.
    if (CHALLENGE_TITLE.test(title)) return 'Cloudflare is still holding us on its challenge page';
    return null;
}

/**
 * Decide whether the loaded page is a dead end rather than the page we asked for. Call
 * {@link detectBlocked} first — a refusal is not a missing item.
 *
 * Returns the reason the check fired — ready to use as `errorMessage` — or `null` if this looks
 * like the real thing. Status and URL are checked before the DOM because they are free.
 */
export async function detectNotFound(
    page: Page,
    { status, url, kind }: { status?: number; url: string; kind: PageKind },
): Promise<string | null> {
    if (status != null && GONE_STATUSES.has(status)) return `DHGate answered HTTP ${status} for this ${kind} URL`;

    if (!URL_SHAPE[kind].test(url)) return `not a DHGate ${kind} page: ${url}`;

    // `.catch()`: a page that navigated mid-evaluate is not evidence of a missing page — let the
    // extractors be the ones to report what they could not find.
    const reason = await (kind === 'product' ? productIsGone(page) : sellerIsGone(page)).catch(() => null);
    return reason;
}

/**
 * The product app is Next.js: a removed listing renders its not-found tree into
 * `<html id="__next_error__">` under a `404: This page could not be found.` title. DHGate also
 * serves a soft error page with HTTP 200 — recognizable by its `pcen.error` tracking namespace,
 * which is the only stable thing on it.
 */
async function productIsGone(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        if (document.documentElement.id === '__next_error__' || /^404\b/.test(document.title.trim())) {
            return 'DHGate rendered its 404 page instead of the product';
        }
        const html = document.documentElement.innerHTML;
        if (html.includes('pcen.error') || /item\s+doesn.{0,8}t\s+exist/i.test(html)) {
            return 'DHGate rendered its "item doesn\'t exist" page instead of the product';
        }
        return null;
    });
}

/**
 * The store app is the legacy stack, and its error page has changed shape more than once — so the
 * store is judged present rather than absent: the header block is server-rendered on every store
 * tab (home, top-selling, about-us), and no error page carries it. Anything without it is not a
 * store page, whatever DHGate decides to render there next.
 */
async function sellerIsGone(page: Page): Promise<string | null> {
    const hasStoreHeader = await page.evaluate(
        () => document.querySelector('.store-head-warp, .storeinfo, .storelogo') != null,
    );
    return hasStoreHeader ? null : 'no store header on the page — the store is closed or the URL is wrong';
}
