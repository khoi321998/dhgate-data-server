import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import type { Page } from 'playwright';

import { MAX_REQUEST_RETRIES, PARALLEL_SELLER } from '../config.js';
import type { CaptureMode, ProductSellerResponse } from '../dto/index.js';
import { detectBlocked, detectNotFound } from '../extractors/notFound.js';
import { extractDescription } from '../extractors/product/description.js';
import { extractHeadlineStats } from '../extractors/product/headlineStats.js';
import { extractMedia } from '../extractors/product/media.js';
import { extractPaymentMethods } from '../extractors/product/paymentMethods.js';
import { extractPricing } from '../extractors/product/pricing.js';
import { extractReviews } from '../extractors/product/reviews.js';
import { extractSellerInline } from '../extractors/product/seller.js';
import { extractDeliveryTimeText } from '../extractors/product/shipping.js';
import { extractSpecifications } from '../extractors/product/specifications.js';
import { extractAvailableQuantity } from '../extractors/product/stock.js';
import { extractTitle } from '../extractors/product/title.js';
import { mergeSellerPart } from '../merge.js';
import { pushItem } from '../push.js';
import { blockUnneededRequests } from '../utils/blocking.js';
import { effectiveStatus, settleCloudflareChallenge } from '../utils/cloudflare.js';
import { DEBUG_PAGE_ERRORS, readPageErrors } from '../utils/debug.js';
import { emptyProduct, emptyResponse, emptySeller, errorResponse } from '../utils/defaults.js';
import { extractProductId, normalizeDhgateHost } from '../utils/parse.js';
import { reportedUrl } from '../utils/request.js';
import { logPageErrors, releasePage } from '../utils/tabs.js';
import { scrapeStorePage, sellerRow } from './seller.js';

/** Navigation budget for the store page's tab (Crawlee's own pages get 60 s too). */
const STORE_NAVIGATION_TIMEOUT_MILLIS = 60_000;

/** The store page's row, or why the tab could not produce one. */
type StoreTabOutcome = { row: ProductSellerResponse } | { error: Error };

/**
 * Handle a DHGate product detail page.
 *
 * Currently scrapes title + pricing only; the rest of the Product is left at its
 * defaults so the response always matches the {@link ProductSellerResponse} contract.
 * `mode` is threaded in so we know whether to also enqueue the seller later.
 */
export async function handleProduct(ctx: PlaywrightCrawlingContext, mode: CaptureMode): Promise<void> {
    const { request, page, log } = ctx;
    const url = request.loadedUrl ?? request.url;
    // What the row reports: the caller's original URL, not our normalized rewrite of it.
    const outUrl = reportedUrl(request);
    // The store page opens in a tab of this browser context, so it ships to the same country as this
    // page — the `b2b_ship_country` cookie is set on the context (see server.ts) — and one row never
    // mixes two regional contexts.
    const wantSeller = mode === 'product_and_seller';

    // The status that describes the DOM we are about to read — which is not `ctx.response`'s when
    // a Cloudflare challenge stood in front of it and then handed us the real page. See
    // utils/cloudflare.ts.
    const status = effectiveStatus(request, ctx.response?.status());

    // Refusals first: a 5xx or an anti-bot interstitial says nothing about the listing, so throw
    // and let Crawlee retry on a new session rather than record an error page as a product.
    const blocked = await detectBlocked(page, status);
    if (blocked) throw new Error(`${blocked} for ${url} — retrying with a new session`);

    // Then the ordinary failure on a marketplace: the listing is simply gone. Checked before the
    // extractors, every one of which would otherwise wait out its own timeout against a DOM that
    // will never mount, and leave a row of nulls that reads like selector rot.
    const notFound = await detectNotFound(page, { status, url, kind: 'product' });
    if (notFound) {
        log.warning(`[product] item not found — ${notFound}`, { url });
        await pushItem(ctx, errorResponse(outUrl, mode, 'ITEM_NOT_FOUND', notFound));
        return;
    }

    // Read-only extractors can run concurrently. extractMedia hovers the gallery
    // (a DOM side effect), so it must run AFTER the price/title reads to avoid
    // racing them — otherwise the price read can pick up the wrong value.
    const id = extractProductId(url) ?? '';

    // product_and_seller: start the store page now, in another tab of this request's browser, instead
    // of after every extractor below — it runs while they do and is awaited at the end. Its link is in
    // the server-rendered store header at the top of the PDP, so reading it needs no scroll and does
    // not race the extractors.
    const parallelStoreUrl = wantSeller && PARALLEL_SELLER ? await readStoreUrl(page) : null;
    if (parallelStoreUrl) log.info(`Opening seller store page in a parallel tab: ${parallelStoreUrl}`);
    const parallelStore = parallelStoreUrl ? scrapeStoreInTab(ctx, parallelStoreUrl, outUrl, mode) : null;

    // Read-only extractors + the reviews API call can run concurrently. extractMedia
    // hovers the gallery (a DOM side effect), so it must run AFTER the price/title
    // reads to avoid racing them — otherwise the price read can pick up the wrong value.
    // Each extractor logs its own line as soon as it resolves, so a tester can watch
    // the run and see exactly what each piece of the Product DTO collected.
    // Every read below races the crash watch: a crashed page is retried within a second instead of
    // after the extractors have waited out their timeouts on it (30 s for the price alone).
    const crashWatch = watchForAppCrash(ctx);
    const [title, pricing, specifications, headline, availableQuantity, reviews, deliveryTimeText] =
        await crashWatch.race(
            Promise.all([
                extractTitle(page).then((r) => {
                    log.info(`[product] title: ${r ?? '(none)'}`);
                    return r;
                }),
                extractPricing(page).then((r) => {
                    log.info('[product] pricing', {
                        currency: r.currency,
                        priceMin: r.priceMin,
                        priceMax: r.priceMax,
                    });
                    return r;
                }),
                extractSpecifications(page).then((r) => {
                    log.info(`[product] specifications: count=${r.length}`);
                    return r;
                }),
                extractHeadlineStats(page).then((r) => {
                    log.info('[product] headlineStats', {
                        rating: r.rating,
                        reviewCount: r.reviewCount,
                        soldCount: r.soldCount,
                    });
                    return r;
                }),
                extractAvailableQuantity(page).then((r) => {
                    log.info(`[product] availableQuantity: ${r ?? '(none)'}`);
                    return r;
                }),
                extractReviews(page, id).then((r) => {
                    log.info('[product] reviews', {
                        reviewSamples: r.reviewSamples.length,
                        ratingBreakdown: r.ratingBreakdown,
                    });
                    return r;
                }),
                extractDeliveryTimeText(page).then((r) => {
                    log.info(`[product] deliveryTimeText: ${r ?? '(none)'}`);
                    return r;
                }),
            ]),
        );
    const media = await crashWatch.race(extractMedia(page));
    log.info('[product] media', { images: media.images.length, videos: media.videos.length });

    // An API call from the page, not the "Buyer Protection" modal: no DOM side effect.
    const paymentMethods = await crashWatch.race(extractPaymentMethods(page));
    log.info(`[product] paymentMethods: ${paymentMethods.join(', ') || '(none)'}`);

    // Runs after the price/title reads: scrolls down to mount the lazy description block
    // (same DOM side effect as extractSellerInline below).
    const description = await crashWatch.race(extractDescription(page));
    log.info('[product] description', {
        plainTextChars: description.plainText.length,
        htmlChars: description.html.length,
    });

    // Runs last: it scrolls down the page (a DOM side effect), so it must not race the
    // price/title reads above. Only needed when we also want the seller.
    const sellerInline = wantSeller ? await crashWatch.race(extractSellerInline(page)) : null;
    crashWatch.stop();
    if (sellerInline) {
        log.info('[product] sellerInline', {
            sellerId: sellerInline.ref.platformSellerId,
            name: sellerInline.ref.name,
            positiveFeedbackPercent: sellerInline.positiveFeedbackPercent,
            badges: sellerInline.badges.length,
        });
    }

    const product = emptyProduct();
    product.id = id;
    product.title = title ?? '';
    product.pricing = pricing;
    product.specifications = specifications;
    product.media = media;
    product.paymentMethods = paymentMethods;
    product.description = description;
    product.deliveryTimeText = deliveryTimeText;
    product.stock.soldCount = headline.soldCount;
    product.stock.availableQuantity = availableQuantity;
    product.reviewsSummary.rating = headline.rating;
    product.reviewsSummary.reviewCount = headline.reviewCount;
    product.reviewsSummary.ratingBreakdown = reviews.ratingBreakdown;
    product.reviewsSummary.reviewSamples = reviews.reviewSamples;

    const response: ProductSellerResponse = { ...emptyResponse(outUrl, mode), product };

    // In product_and_seller mode, resolve the seller from the PDP's "About the Store"
    // block and seed the seller profile with what's available inline.
    if (sellerInline) {
        response.sellerRef = sellerInline.ref;
        const seller = emptySeller();
        seller.platformSellerId = sellerInline.ref.platformSellerId;
        seller.name = sellerInline.ref.name;
        seller.url = sellerInline.ref.url;
        seller.positiveFeedbackPercent = sellerInline.positiveFeedbackPercent;
        seller.avatarUrl = sellerInline.avatarUrl;
        seller.badges = sellerInline.badges;
        response.seller = seller;
    }

    log.info(`[product] scraped: ${product.title || '(no title)'} (id=${product.id || '(none)'})`);

    // Done with the product page. When a store page is still to come, unload this one now instead of
    // keeping DHGate's app (scripts, video, trackers) running until the store is in. It is blanked, not
    // closed: it is Crawlee's page, and with a browser's only Crawlee page closed the pool closes the
    // browser — and the store tab with it. Crawlee closes it after the handler.
    if (parallelStore || (wantSeller && sellerInline?.ref.url)) await releasePage(page);

    // The store page: the parallel tab's result, or — when its link was not in the header — a tab
    // opened now from the "About the Store" block's link.
    let store = parallelStore ? await parallelStore : null;
    if (!store && wantSeller && sellerInline?.ref.url) {
        log.info(`Opening seller store page: ${sellerInline.ref.name ?? ''}`, {
            sellerId: sellerInline.ref.platformSellerId,
            storeUrl: sellerInline.ref.url,
        });
        store = await scrapeStoreInTab(ctx, normalizeDhgateHost(sellerInline.ref.url), outUrl, mode);
    }
    if (wantSeller && !store) {
        log.warning('product_and_seller mode: no seller store URL found on PDP — pushing product only', { url });
    }

    let row = response;
    if (store && 'error' in store) {
        // The store page was refused or broke: retry the whole request, in a new browser on a new
        // session, like any other failed page.
        if (request.retryCount < MAX_REQUEST_RETRIES) {
            throw new Error(`store page failed: ${store.error.message} — retrying with a new session`);
        }
        // Out of retries: keep the good product and report only the seller as unreachable.
        row = mergeSellerPart(
            response,
            errorResponse(
                outUrl,
                mode,
                'FETCH_FAILED',
                `store page: gave up after ${request.retryCount} retries: ${store.error.message}`,
            ),
        );
    } else if (store) {
        row = mergeSellerPart(response, store.row);
    }

    await pushItem(ctx, row);
}

/**
 * Open the store page in a new tab of this request's browser and scrape it. The tab shares the
 * request's cookies (locale, ship-to, Cloudflare clearance) and proxy session. It is not one of
 * Crawlee's pages, so the Cloudflare wait the navigation hooks give those is done here; a challenge it
 * cannot wait out fails the store page.
 *
 * Never rejects: the outcome is awaited only after the product extractors, and a rejection sitting
 * unawaited in the meantime would be reported as unhandled.
 */
async function scrapeStoreInTab(
    ctx: PlaywrightCrawlingContext,
    storeUrl: string,
    outUrl: string,
    mode: CaptureMode,
): Promise<StoreTabOutcome> {
    const { page, log } = ctx;
    let tab: Page | undefined;
    try {
        tab = await page.context().newPage();
        logPageErrors(tab, 'seller');
        await blockUnneededRequests(tab);
        // `domcontentloaded`, as for every page Crawlee opens here (see server.ts).
        const navigation = await tab.goto(storeUrl, {
            waitUntil: 'domcontentloaded',
            timeout: STORE_NAVIGATION_TIMEOUT_MILLIS,
        });
        const challenge = await settleCloudflareChallenge(tab);
        if (challenge.outcome === 'stuck')
            throw new Error('Cloudflare is still holding the store page on its challenge');
        // Past a challenge, the recorded status belongs to the interstitial — see `effectiveStatus`.
        const status = challenge.outcome === 'passed' ? undefined : navigation?.status();

        // The tab is ours, so it is closed as soon as its own reads are done, without waiting for the
        // About Us tab it opened.
        const storeTab = tab;
        const result = await scrapeStorePage(tab, log, tab.url(), status, async () => storeTab.close());
        if (result.kind === 'blocked') throw new Error(`${result.reason} for ${storeUrl}`);
        if (result.kind === 'notFound') return { row: errorResponse(outUrl, mode, 'SELLER_NOT_FOUND', result.reason) };
        return { row: sellerRow(outUrl, mode, result.seller) };
    } catch (error) {
        return { error: error as Error };
    } finally {
        await tab?.close().catch(() => undefined);
    }
}

/**
 * DHGate's product page is a Next.js app, and it sometimes crashes into "Application error: a
 * client-side exception has occurred" — seen after a `ChunkLoadError` and after an API call that came
 * back empty (`ERR_TUNNEL_CONNECTION_FAILED` / `429` through the proxy), but also without a proxy and
 * with no cause in reach: Patchright keeps the page's console closed. Nothing on that page is the
 * product, so the attempt is retried in a new browser on a new session (see `watchForAppCrash`).
 */
const APP_CRASHED = `DHGate's page crashed in the browser (Next.js "Application error")`;

/** How often the crash watch looks at the page. */
const CRASH_POLL_MILLIS = 1_000;

/**
 * Watch the page for Next's crash screen while the extractors run, and make `race(work)` reject
 * the moment it shows, so the attempt is retried in a new browser on a new session without waiting
 * for `work`. On the last attempt it never rejects: the fields read before the crash are kept.
 * `stop()` ends the polling; it also ends on its own once the page is closed.
 */
function watchForAppCrash({ page, request, log }: PlaywrightCrawlingContext): {
    race: <T>(work: Promise<T>) => Promise<T>;
    stop: () => void;
} {
    const retriesLeft = request.retryCount < MAX_REQUEST_RETRIES;
    let stopped = false;
    const crashed = new Promise<never>((_resolve, reject) => {
        void (async () => {
            while (!stopped && !page.isClosed()) {
                const isCrashed = await page
                    .evaluate(() => /Application error: a client-side exception/i.test(document.body?.innerText ?? ''))
                    .catch(() => false);
                if (isCrashed && !stopped) {
                    stopped = true;
                    // Before the retry closes the page: what it recorded is the only trace of why.
                    if (DEBUG_PAGE_ERRORS) {
                        log.warning(`[crash debug] ${APP_CRASHED} at ${page.url()}`);
                        for (const line of await readPageErrors(page)) log.warning(`[crash debug] ${line}`);
                    }
                    if (retriesLeft) {
                        reject(new Error(`${APP_CRASHED} — retrying with a new session`));
                    } else {
                        log.warning(`[product] ${APP_CRASHED} and retries are spent — keeping what was read before`);
                    }
                    return;
                }
                await new Promise((resolve) => {
                    setTimeout(resolve, CRASH_POLL_MILLIS);
                });
            }
        })();
    });
    // Handled here once, so a crash seen after the last `race` is not an unhandled rejection.
    crashed.catch(() => undefined);
    return {
        race: async <T>(work: Promise<T>) => Promise.race([work, crashed]),
        stop: () => {
            stopped = true;
        },
    };
}

/**
 * The store URL from the PDP's store header (`[spm-c="logostore"]`, server-rendered at the top of the
 * page), absolute, on the `www` host and without query / hash. `null` when the page has none.
 */
async function readStoreUrl(page: PlaywrightCrawlingContext['page']): Promise<string | null> {
    const href = await page
        .locator('a[spm-index="store"][href*="/store/"]')
        .first()
        .getAttribute('href', { timeout: 5_000 })
        .catch(() => null);
    if (!href) return null;
    try {
        const absolute = new URL(href, page.url());
        return normalizeDhgateHost(`${absolute.origin}${absolute.pathname}`);
    } catch {
        return null;
    }
}
