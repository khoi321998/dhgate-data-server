import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import type { CaptureMode, ProductSellerResponse } from '../dto/index.js';
import { extractTitle } from '../extractors/product/title.js';
import { extractPricing } from '../extractors/product/pricing.js';
import { extractMedia } from '../extractors/product/media.js';
import { extractDescription } from '../extractors/product/description.js';
import { extractSpecifications } from '../extractors/product/specifications.js';
import { extractHeadlineStats } from '../extractors/product/headlineStats.js';
import { extractAvailableQuantity } from '../extractors/product/stock.js';
import { extractReviews } from '../extractors/product/reviews.js';
import { extractDeliveryTimeText } from '../extractors/product/shipping.js';
import { extractPaymentMethods } from '../extractors/product/paymentMethods.js';
import { extractSellerInline } from '../extractors/product/seller.js';
import { detectBlocked, detectNotFound } from '../extractors/notFound.js';
import { effectiveStatus } from '../utils/cloudflare.js';
import { emptyProduct, emptyResponse, emptySeller, errorResponse } from '../utils/defaults.js';
import { extractProductId, normalizeDhgateHost } from '../utils/parse.js';
import { reportedUrl } from '../utils/request.js';
import { pushItem } from '../push.js';
import { LABELS } from '../labels.js';

/**
 * Handle a DHGate product detail page.
 *
 * Currently scrapes title + pricing only; the rest of the Product is left at its
 * defaults so the response always matches the {@link ProductSellerResponse} contract.
 * `mode` is threaded in so we know whether to also enqueue the seller later.
 */
export async function handleProduct(ctx: PlaywrightCrawlingContext, mode: CaptureMode): Promise<void> {
    const { request, page, log, addRequests } = ctx;
    const url = request.loadedUrl ?? request.url;
    // What the row reports: the caller's original URL, not our normalized rewrite of it.
    const outUrl = reportedUrl(request);
    const wantSeller = mode === 'product_and_seller';
    // Carried from the start URL's subdomain (see server.ts). The seller page must be visited
    // with the same ship-to country, otherwise one row mixes two regional contexts.
    const { shipCountry } = request.userData as { shipCountry?: string };

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

    // Read-only extractors + the reviews API call can run concurrently. extractMedia
    // hovers the gallery (a DOM side effect), so it must run AFTER the price/title
    // reads to avoid racing them — otherwise the price read can pick up the wrong value.
    // Each extractor logs its own line as soon as it resolves, so a tester can watch
    // the run and see exactly what each piece of the Product DTO collected.
    const [title, pricing, specifications, headline, availableQuantity, reviews, deliveryTimeText] = await Promise.all([
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
            log.info('[product] headlineStats', { rating: r.rating, reviewCount: r.reviewCount, soldCount: r.soldCount });
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
    ]);
    const media = await extractMedia(page);
    log.info('[product] media', { images: media.images.length, videos: media.videos.length });

    // Runs after the price/title reads: opens the "Buyer Protection" modal (a DOM
    // side effect), so it must not race the concurrent reads above.
    const paymentMethods = await extractPaymentMethods(page);
    log.info(`[product] paymentMethods: ${paymentMethods.join(', ') || '(none)'}`);

    // Runs after the price/title reads: scrolls to the bottom to mount the lazy
    // description block (same DOM side effect as extractSellerInline below).
    const description = await extractDescription(page);
    log.info('[product] description', { plainTextChars: description.plainText.length, htmlChars: description.html.length });

    // Runs last: it scrolls to the bottom of the page (a DOM side effect), so it must
    // not race the price/title reads above. Only needed when we also want the seller.
    const sellerInline = wantSeller ? await extractSellerInline(page) : null;
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

    // Hand off to the seller store page so the seller handler can enrich the
    // profile and push ONE merged row. The full response is carried in userData.
    // The uniqueKey includes the product id so the same store is still visited
    // once per product (instead of being deduped across products).
    if (wantSeller && sellerInline?.ref.url) {
        log.info(`Enqueuing seller store page: ${sellerInline.ref.name ?? ''}`, {
            sellerId: sellerInline.ref.platformSellerId,
            storeUrl: sellerInline.ref.url,
        });
        await addRequests([
            {
                url: normalizeDhgateHost(sellerInline.ref.url),
                label: LABELS.SELLER,
                // Prefixed with this request's own key (unique per `POST /scrape` call): the crawler
                // is long-lived, so without it a second call for the same product would have its
                // seller page deduped away and never get a row.
                uniqueKey: `${request.uniqueKey}|seller:${id}:${sellerInline.ref.platformSellerId ?? sellerInline.ref.url}`,
                // `inputUrl` rides along so the seller handler still reports the caller's URL
                // if it ever has to build a row of its own. The rest of `userData` (job id, mode)
                // is inherited so the seller row completes the same job.
                userData: { ...request.userData, partialResponse: response, shipCountry, inputUrl: outUrl },
            },
        ]);
        return; // the seller handler pushes the combined row
    }

    if (wantSeller && !sellerInline?.ref.url) {
        log.warning('product_and_seller mode: no seller store URL found on PDP — pushing product only', { url });
    }

    // No seller to visit (product_only, or the seller block was missing): push as-is.
    await pushItem(ctx, response);
}
