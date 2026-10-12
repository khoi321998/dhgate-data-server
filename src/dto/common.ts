/** Marketplace the data was scraped from. Extend as more platforms are added. */
export type Platform = 'dhgate';

/**
 * What a single run captures:
 * - `product_only`        — visit the product page, scrape the product (seller stays null).
 * - `product_and_seller`  — visit the product page, scrape product AND its seller.
 * - `seller_only`         — visit a seller/store URL, scrape only the seller (product stays null).
 */
export type CaptureMode = 'product_only' | 'product_and_seller' | 'seller_only';

/**
 * Why a row is incomplete. `null` on a fully successful row.
 *
 * - `ITEM_NOT_FOUND` — the listing is gone: DHGate answered 404/410, rendered an error page, or
 *   bounced us off the product URL entirely. The row carries no product.
 * - `SELLER_NOT_FOUND` — same, for the store page. In `product_and_seller` the product was
 *   already scraped and is kept; only the seller half is missing.
 * - `FETCH_FAILED` — we never got a usable page: navigation errors, or DHGate refusing us
 *   (anti-bot, 5xx) through every retry. Says nothing about whether the item exists.
 *
 * Add a member here (not a free-form string) whenever a new failure becomes worth telling the
 * caller apart from a generic crawl error — the point of the code is that it can be branched on.
 */
export type ScrapeErrorCode = 'ITEM_NOT_FOUND' | 'SELLER_NOT_FOUND' | 'FETCH_FAILED';
