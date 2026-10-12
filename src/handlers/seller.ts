import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import type { CaptureMode, ProductSellerResponse, Seller } from '../dto/index.js';
import { extractSellerProducts } from '../extractors/seller/products.js';
import { extractSellerHeader } from '../extractors/seller/header.js';
import { extractSellerAbout } from '../extractors/seller/about.js';
import { extractSellerFeedback } from '../extractors/seller/feedback.js';
import { detectBlocked, detectNotFound } from '../extractors/notFound.js';
import { effectiveStatus } from '../utils/cloudflare.js';
import { emptyResponse, emptySeller } from '../utils/defaults.js';
import { extractSellerId } from '../utils/parse.js';
import { reportedUrl } from '../utils/request.js';
import { pushItem } from '../push.js';

/**
 * Handle a DHGate seller/store page.
 *
 * Two entry paths:
 * - `product_and_seller` — reached by enqueue from the product handler, which passes
 *   the already-scraped {@link ProductSellerResponse} in `userData.partialResponse`.
 *   We enrich its `seller` with store-page data and push ONE merged row.
 * - `seller_only` — reached directly from a start URL with no carried response; we
 *   build a fresh seller-only row (`product` stays null).
 */
export async function handleSeller(ctx: PlaywrightCrawlingContext, mode: CaptureMode): Promise<void> {
    const { request, page, log } = ctx;
    const url = request.loadedUrl ?? request.url;
    // What the row reports: the caller's original URL, not our normalized rewrite of it.
    const outUrl = reportedUrl(request);

    const partial = (request.userData as { partialResponse?: ProductSellerResponse } | undefined)?.partialResponse;

    // The status that describes the DOM we are about to read — which is not `ctx.response`'s when
    // a Cloudflare challenge stood in front of it and then handed us the real page. See
    // utils/cloudflare.ts.
    const status = effectiveStatus(request, ctx.response?.status());

    // Refusals first: DHGate answers a browser with 502 where its CDN answers curl with a clean
    // 404, so a 5xx says nothing about the store. Throw rather than push — Crawlee retries on a
    // new session, instead of us recording a healthy-looking row scraped from an error page.
    const blocked = await detectBlocked(page, status);
    if (blocked) throw new Error(`${blocked} for ${url} — retrying with a new session`);

    // Then: is this a store page at all? A mistyped `seller_only` start URL and a closed store
    // both land somewhere without a store header, where every extractor below waits out its own
    // timeout and extractSellerAbout/Feedback click store tabs that do not exist — a minute per
    // URL, ending in a row of nulls that looks like selector rot.
    const notFound = await detectNotFound(page, { status, url, kind: 'seller' });
    if (notFound) {
        log.warning(`[seller] store page not found — ${notFound}`, { url });
        // In product_and_seller the product half was already scraped and is carried in `partial`:
        // keep it and report only the seller as missing, rather than losing a good product to a
        // dead store link.
        const failed = partial ?? emptyResponse(outUrl, mode);
        failed.success = false;
        failed.errorCode = 'SELLER_NOT_FOUND';
        failed.errorMessage = notFound;
        await pushItem(ctx, failed);
        return;
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

    // These navigate to other store tabs, so they must run AFTER the landing-page reads.
    // About Us first: its page still carries the store nav, so the Review tab is reachable from it.
    const about = await extractSellerAbout(page);
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

    const feedback = await extractSellerFeedback(page);
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

    // Start from the inline seller carried off the PDP, or a fresh profile for seller_only.
    const seller: Seller = partial?.seller ?? emptySeller();
    if (!seller.url) seller.url = url;
    seller.productPreviews = productPreviews;
    // Identity: in product_and_seller these come off the PDP, so only fill the gaps.
    // In seller_only there's no PDP, so the store header is the sole source.
    seller.name ??= header.name;
    seller.platformSellerId ??= extractSellerId(url);
    seller.avatarUrl ??= header.avatarUrl;
    if (seller.badges.length === 0) seller.badges = header.badges;
    // Feedback %/transactions: prefer the store header, fall back to the review-page
    // header (some store layouts omit the header feedback panel), then keep whatever
    // the PDP inline block already provided.
    seller.positiveFeedbackPercent =
        header.positiveFeedbackPercent ?? feedback.positiveFeedbackPercent ?? seller.positiveFeedbackPercent;
    seller.transactions = header.transactions ?? feedback.transactions ?? seller.transactions;
    if (about) seller.about = about;
    if (feedback.reviewScore) seller.reviewScore = feedback.reviewScore;
    if (feedback.serviceScore) seller.serviceScore = feedback.serviceScore;
    // Each bucket is written only when it produced cards, so a filter we could not reach
    // leaves whatever the PDP already supplied instead of blanking it.
    if (feedback.reviews.positive.length > 0) seller.positiveReviewSamples = feedback.reviews.positive;
    if (feedback.reviews.neutral.length > 0) seller.neutralReviewSamples = feedback.reviews.neutral;
    if (feedback.reviews.negative.length > 0) seller.negativeReviewSamples = feedback.reviews.negative;

    const response: ProductSellerResponse = partial ?? {
        ...emptyResponse(outUrl, mode),
        sellerRef: { platformSellerId: seller.platformSellerId, name: seller.name, url: seller.url },
        seller,
    };
    response.seller = seller;
    await pushItem(ctx, response);
}
