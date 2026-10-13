import type { Page } from 'playwright';
import type { SellerProductPreview } from '../../dto/index.js';
import { parseAmount, parseCompactNumber, stripUrlParams, normalizeImageUrl } from '../../utils/parse.js';

/**
 * Parse a rating bar's fill width into a 0–5 star rating.
 * The bar is `<span class="rating"><span style="width:90%;"></span></span>`,
 * where 100% == 5 stars, so `rating = percent / 20` (e.g. 90% -> 4.5).
 */
export function ratingFromWidth(style: string | null): number | null {
    if (!style) return null;
    const match = style.match(/width:\s*([\d.]+)%/i);
    if (!match) return null;
    const percent = parseFloat(match[1]);
    return Number.isFinite(percent) ? Math.round((percent / 20) * 10) / 10 : null;
}

/** Compute a positive discount percentage from list/original prices, or null if either is missing. */
export function discountPercent(price: number | null, originalPrice: number | null): number | null {
    if (price == null || originalPrice == null || originalPrice <= 0 || price >= originalPrice) return null;
    return Math.round(((originalPrice - price) / originalPrice) * 100);
}

/**
 * Extract the seller's product previews from the store page's "top selling" strip.
 *
 * Each card lives in `#proGallery .gitem` (the legacy storefront template uses stable
 * class names, unlike the hashed React classes on the PDP). Within a card:
 * - `a.pic[itemcode]`        -> product id + product URL
 * - `a.pro-title[title]`     -> full (untruncated) title
 * - `img.gthumbnail`         -> thumbnail image
 * - `li.price span`          -> price text ("US $14.90" or "US $13.96 - 14.63")
 * - `li.costprice span`      -> original/list price (optional)
 * - `.pro-sold .num`         -> sold count ("5K+")
 * - `.pro-rating .rating > span` (fill width) + `.pro-rating .num` -> rating + review count
 */
/** Cap on how many product previews we keep per seller. */
export const MAX_PREVIEWS = 10;

export async function extractSellerProducts(page: Page): Promise<SellerProductPreview[]> {
    // The `#proGallery .gitem` strip only exists on the store's Top-Selling tab — NOT on
    // the about-us page a seller_only run starts from, nor on the store home a PDP's store
    // link points to (home uses `.gitemwrap .gitem`, with no `#proGallery` wrapper). Click
    // the Top-Selling tab in the store nav to get there. That page still carries the full
    // store header and the About Us nav link, so the header/about/feedback extractors that
    // read the page afterwards keep working. Skip the click when we're already on that tab.
    if (!/\/store\/top-selling\//.test(page.url())) {
        const topSellingTab = page.locator('#storeNav a[spm-c="onctopsell"]').first();
        if ((await topSellingTab.count()) > 0) {
            await topSellingTab.click().catch(() => {});
        }
    }

    const gallery = page.locator('#proGallery .gitem');
    await gallery
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 })
        .catch(() => {});
    if ((await gallery.count()) === 0) return [];

    // Every field of every card in one round trip. Reading them through locators cost two CDP calls
    // per field (count, then read) — ~180 for ten cards, ~10 s through the proxy — for strings the
    // browser has at hand. Only the raw strings come back; parsing stays below, unchanged.
    // No named helper functions in here: `tsx` (esbuild) wraps them in `__name(...)`, which does not
    // exist in the page, so the dev server would throw where the tsc build works.
    const cards = await page.$$eval('#proGallery .gitem', (items) =>
        items.map((item) => ({
            itemcode: item.querySelector('a.pic')?.getAttribute('itemcode') ?? null,
            href: item.querySelector('a.pic')?.getAttribute('href') ?? null,
            imageSrc: item.querySelector('img.gthumbnail')?.getAttribute('src') ?? null,
            titleAttr: item.querySelector('a.pro-title')?.getAttribute('title') ?? null,
            titleText: (item.querySelector('a.pro-title')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            priceText: (item.querySelector('li.price span')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            originalPriceText: (item.querySelector('li.costprice span')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            // The preview strip often renders an EMPTY .pro-rating (no `.rating > span`).
            ratingStyle: item.querySelector('.pro-rating .rating > span')?.getAttribute('style') ?? null,
            reviewText: (item.querySelector('.pro-rating .num')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        })),
    );

    return previewsFromCards(cards);
}

/** One gallery card's raw strings, as read off a store page (in the browser or from fetched HTML). */
export interface RawPreviewCard {
    itemcode: string | null;
    href: string | null;
    imageSrc: string | null;
    titleAttr: string | null;
    titleText: string;
    priceText: string;
    originalPriceText: string;
    ratingStyle: string | null;
    reviewText: string;
}

/** Turn gallery cards into previews: the first {@link MAX_PREVIEWS} with a product reference. */
export function previewsFromCards(cards: RawPreviewCard[]): SellerProductPreview[] {
    const previews: SellerProductPreview[] = [];
    for (const card of cards) {
        // Keep at most MAX_PREVIEWS.
        if (previews.length >= MAX_PREVIEWS) break;

        const productId = (card.itemcode ?? '').trim() || null;
        const url = stripUrlParams(card.href);
        const imageUrl = normalizeImageUrl(card.imageSrc);
        const title = (card.titleAttr ?? card.titleText ?? '').replace(/\s+/g, ' ').trim() || null;

        const priceText = card.priceText || null;
        const originalPriceText = card.originalPriceText || null;
        const price = parseAmount(priceText);
        const originalPrice = parseAmount(originalPriceText);

        // Skip rows that carry no product reference (defensive: spacer/ad cards).
        if (!productId && !url) continue;

        // Drop keys with no value so absent fields (e.g. rating on cards without a
        // rating bar) are omitted from the output rather than emitted as null.
        previews.push(
            compact({
                productId,
                title,
                url,
                imageUrl,
                price,
                originalPrice,
                originalPriceText,
                discountPercent: discountPercent(price, originalPrice),
                rating: ratingFromWidth(card.ratingStyle),
                reviewCount: parseCompactNumber(card.reviewText),
            }),
        );
    }

    return previews;
}

/** Return a copy of `obj` with all null/undefined-valued keys removed. */
export function compact(obj: Record<string, unknown>): SellerProductPreview {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== null && value !== undefined) out[key] = value;
    }
    return out as SellerProductPreview;
}
