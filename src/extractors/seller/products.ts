import type { Page } from 'playwright';
import type { SellerProductPreview } from '../../dto/index.js';
import { parseAmount, parseCompactNumber, stripUrlParams, normalizeImageUrl } from '../../utils/parse.js';

/**
 * Parse a rating bar's fill width into a 0–5 star rating.
 * The bar is `<span class="rating"><span style="width:90%;"></span></span>`,
 * where 100% == 5 stars, so `rating = percent / 20` (e.g. 90% -> 4.5).
 */
function ratingFromWidth(style: string | null): number | null {
    if (!style) return null;
    const match = style.match(/width:\s*([\d.]+)%/i);
    if (!match) return null;
    const percent = parseFloat(match[1]);
    return Number.isFinite(percent) ? Math.round((percent / 20) * 10) / 10 : null;
}

/** Compute a positive discount percentage from list/original prices, or null if either is missing. */
function discountPercent(price: number | null, originalPrice: number | null): number | null {
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
const MAX_PREVIEWS = 10;

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

    const previews: SellerProductPreview[] = [];
    for (const item of await gallery.all()) {
        // Keep at most MAX_PREVIEWS; stop reading further cards' DOM once we hit it.
        if (previews.length >= MAX_PREVIEWS) break;

        const pic = item.locator('a.pic').first();

        const productId = ((await readAttr(pic, 'itemcode')) ?? '').trim() || null;
        const url = stripUrlParams(await readAttr(pic, 'href'));
        const imageUrl = normalizeImageUrl(await readAttr(item.locator('img.gthumbnail').first(), 'src'));

        const titleLoc = item.locator('a.pro-title').first();
        const title =
            ((await readAttr(titleLoc, 'title')) ?? (await readText(titleLoc)) ?? '').replace(/\s+/g, ' ').trim() ||
            null;

        const priceText = (await readText(item.locator('li.price span').first())) || null;
        const originalPriceText = (await readText(item.locator('li.costprice span').first())) || null;
        const price = parseAmount(priceText);
        const originalPrice = parseAmount(originalPriceText);

        // The preview strip often renders an EMPTY .pro-rating (no `.rating > span`).
        // getAttribute on a zero-match locator waits out the full action timeout and
        // throws, so guard with readAttr (count-checked) instead of calling it directly.
        const ratingStyle = await readAttr(item.locator('.pro-rating .rating > span').first(), 'style');
        const reviewText = await readText(item.locator('.pro-rating .num').first());

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
                rating: ratingFromWidth(ratingStyle),
                reviewCount: parseCompactNumber(reviewText),
            }),
        );
    }

    return previews;
}

/** Return a copy of `obj` with all null/undefined-valued keys removed. */
function compact(obj: Record<string, unknown>): SellerProductPreview {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== null && value !== undefined) out[key] = value;
    }
    return out as SellerProductPreview;
}

/** Read trimmed text content from a locator, returning '' when the element is absent. */
async function readText(loc: ReturnType<Page['locator']>): Promise<string> {
    if ((await loc.count()) === 0) return '';
    return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Read an attribute from a locator, returning null when the element is absent.
 * Unlike a bare `getAttribute`, this never waits out the action timeout on a
 * zero-match locator — it checks `count()` first.
 */
async function readAttr(loc: ReturnType<Page['locator']>, name: string): Promise<string | null> {
    if ((await loc.count()) === 0) return null;
    return await loc.getAttribute(name);
}
