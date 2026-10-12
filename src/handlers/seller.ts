import type { Log, PlaywrightCrawlingContext } from '@crawlee/playwright';
import type { Page } from 'playwright';

import type { CaptureMode, ProductSellerResponse, Seller } from '../dto/index.js';
import { detectBlocked, detectNotFound } from '../extractors/notFound.js';
import { extractSellerAboutAt, readAboutUrl } from '../extractors/seller/about.js';
import { extractSellerFeedback } from '../extractors/seller/feedback.js';
import { extractSellerHeader } from '../extractors/seller/header.js';
import { extractSellerProducts } from '../extractors/seller/products.js';
import { pushItem } from '../push.js';
import { effectiveStatus } from '../utils/cloudflare.js';
import { emptyResponse, emptySeller, errorResponse } from '../utils/defaults.js';
import { extractSellerId } from '../utils/parse.js';
import { reportedUrl } from '../utils/request.js';
import { releasePage, withExtraTab } from '../utils/tabs.js';

/** The About Us side trip's time budget; past it the row goes without `about`. */
const ABOUT_TAB_BUDGET_MILLIS = 25_000;

/** What a store page gave: a seller, or why it gave none. */
export type StorePageResult =
    | { kind: 'seller'; seller: Seller }
    | { kind: 'notFound'; reason: string }
    | { kind: 'blocked'; reason: string };

/**
 * Handle a DHGate seller/store page reached as a start URL (`seller_only`): a seller-only row,
 * `product` stays null. In `product_and_seller` the store page is not a request of its own — the
 * product handler opens it in a tab of the same browser and calls {@link scrapeStorePage}.
 */
export async function handleSeller(ctx: PlaywrightCrawlingContext, mode: CaptureMode): Promise<void> {
    const { request, page, log } = ctx;
    const url = request.loadedUrl ?? request.url;
    // What the row reports: the caller's original URL, not our normalized rewrite of it.
    const outUrl = reportedUrl(request);

    // The status that describes the DOM we are about to read — which is not `ctx.response`'s when
    // a Cloudflare challenge stood in front of it and then handed us the real page. See
    // utils/cloudflare.ts.
    const status = effectiveStatus(request, ctx.response?.status());

    // Crawlee's page: blanked rather than closed once its reads are done (see `releasePage`).
    const result = await scrapeStorePage(page, log, url, status, async () => releasePage(page));
    // A refusal says nothing about the store: throw, and Crawlee retries in a new browser on a new
    // session, instead of us recording a healthy-looking row scraped from an error page.
    if (result.kind === 'blocked') throw new Error(`${result.reason} for ${url} — retrying with a new session`);
    if (result.kind === 'notFound') {
        await pushItem(ctx, errorResponse(outUrl, mode, 'SELLER_NOT_FOUND', result.reason));
        return;
    }
    await pushItem(ctx, sellerRow(outUrl, mode, result.seller));
}

/** A row carrying only the seller, as `seller_only` reports it. */
export function sellerRow(outUrl: string, mode: CaptureMode, seller: Seller): ProductSellerResponse {
    return {
        ...emptyResponse(outUrl, mode),
        sellerRef: { platformSellerId: seller.platformSellerId, name: seller.name, url: seller.url },
        seller,
    };
}

/**
 * Scrape the store page already loaded in `page` (`url` is where it is).
 *
 * The seller is built from the store page alone. In `product_and_seller` the product handler merges
 * it into the PDP's inline seller with `mergeSellerPart` (merge.ts), which keeps the precedence of
 * the PDP-first path: identity from the PDP, stats / previews / about / reviews from here.
 */
export async function scrapeStorePage(
    page: Page,
    log: Log,
    url: string,
    status: number | undefined,
    /** Called once nothing more is read from `page`, so the caller can free it while About Us finishes. */
    pageDone: () => Promise<void>,
): Promise<StorePageResult> {
    // Refusals first: DHGate answers a browser with 502 where its CDN answers curl with a clean
    // 404, so a 5xx says nothing about the store.
    const blocked = await detectBlocked(page, status);
    if (blocked) return { kind: 'blocked', reason: blocked };

    // Then: is this a store page at all? A mistyped `seller_only` start URL and a closed store
    // both land somewhere without a store header, where every extractor below waits out its own
    // timeout and extractSellerAbout/Feedback click store tabs that do not exist — a minute per
    // URL, ending in a row of nulls that looks like selector rot.
    const notFound = await detectNotFound(page, { status, url, kind: 'seller' });
    if (notFound) {
        log.warning(`[seller] store page not found — ${notFound}`, { url });
        return { kind: 'notFound', reason: notFound };
    }

    // Store-page extractors (more will be added as their DOM is mapped).
    // Read the landing page (top-selling) FIRST, then visit the About Us tab —
    // extractSellerAbout navigates away, so anything read off this page must run before it.
    // Each extractor logs its own line as soon as it resolves, so a tester can watch
    // the run and see exactly what each piece of the Seller DTO collected.
    const productPreviews = await extractSellerProducts(page);
    log.info(`[seller] productPreviews: count=${productPreviews.length}`);

    const header = await extractSellerHeader(page);
    log.info('[seller] header', {
        name: header.name,
        avatarUrl: header.avatarUrl ? 'yes' : null,
        positiveFeedbackPercent: header.positiveFeedbackPercent,
        transactions: header.transactions,
        badges: header.badges.length,
        badgeLabels: header.badges,
    });

    // These navigate to other store tabs, so they must run AFTER the landing-page reads. They do not
    // depend on each other — the landing page links both — so About Us loads in a second tab of the
    // same browser while this tab goes on to the Review tab, instead of one after the other.
    // `withExtraTab` never rejects, so the About promise can wait unawaited while Review runs.
    const aboutUrl = await readAboutUrl(page);
    const aboutTab = aboutUrl
        ? withExtraTab(page, 'seller about', ABOUT_TAB_BUDGET_MILLIS, null, async (tab) =>
              extractSellerAboutAt(tab, aboutUrl),
          )
        : Promise.resolve(null);
    const feedback = await extractSellerFeedback(page);
    // Nothing more is read from this tab: free it now, while the About tab (its own tab, closed when
    // done) may still be loading.
    await pageDone();
    const about = await aboutTab;
    if (about) {
        log.info('[seller] about', {
            fields: Object.values(about).filter((v) => v != null && v !== '').length,
            companyName: about.companyName ?? null,
            location: about.location ?? null,
            yearEstablished: about.yearEstablished ?? null,
            introductionChars: about.introduction?.length ?? 0,
        });
    } else {
        log.info('[seller] about: (none)');
    }

    log.info('[seller] feedback', {
        // Per-bucket counts: an empty Neutral/Negative next to a healthy Positive is how a
        // "Reviews:" dropdown that stopped switching shows up.
        reviewSamples: {
            positive: feedback.reviews.positive.length,
            neutral: feedback.reviews.neutral.length,
            negative: feedback.reviews.negative.length,
        },
        positiveFeedbackPercent: feedback.positiveFeedbackPercent,
        transactions: feedback.transactions,
        reviewScore: feedback.reviewScore ?? null,
        serviceScore: feedback.serviceScore
            ? { industry: feedback.serviceScore.industry, items: feedback.serviceScore.items.length }
            : null,
    });

    const seller = emptySeller();
    seller.url = url;
    seller.productPreviews = productPreviews;
    // No PDP here, so the store header is the sole source of identity.
    seller.name = header.name;
    seller.platformSellerId = extractSellerId(url);
    seller.avatarUrl = header.avatarUrl;
    seller.badges = header.badges;
    // Feedback %/transactions: prefer the store header, fall back to the review-page
    // header (some store layouts omit the header feedback panel).
    seller.positiveFeedbackPercent = header.positiveFeedbackPercent ?? feedback.positiveFeedbackPercent;
    seller.transactions = header.transactions ?? feedback.transactions;
    if (about) seller.about = about;
    if (feedback.reviewScore) seller.reviewScore = feedback.reviewScore;
    if (feedback.serviceScore) seller.serviceScore = feedback.serviceScore;
    seller.positiveReviewSamples = feedback.reviews.positive;
    seller.neutralReviewSamples = feedback.reviews.neutral;
    seller.negativeReviewSamples = feedback.reviews.negative;

    return { kind: 'seller', seller };
}
