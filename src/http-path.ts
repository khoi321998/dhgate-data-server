import type { Log } from '@crawlee/playwright';

import type { CaptureMode, ProductSellerResponse } from './dto/index.js';
import { scrapeProductOverHttp } from './extractors/product/http.js';
import type { StoreHttpResult } from './extractors/seller/http.js';
import { scrapeStoreOverHttp } from './extractors/seller/http.js';
import { sellerRow } from './handlers/seller.js';
import { mergeSellerPart } from './merge.js';
import { emptyResponse, emptySeller, errorResponse } from './utils/defaults.js';
import { createHttpClient, localeCookieHeader } from './utils/http.js';
import { extractDhgateShipCountry, normalizeDhgateHost } from './utils/parse.js';

/** The row, or why the HTTP path gave up — then the request goes to the browser, as before. */
export type HttpPathOutcome = { row: ProductSellerResponse } | { fallback: string };

/**
 * Scrape a request without a browser: the product page and the store pages over HTTP, through the
 * request's proxy session (one visitor, one IP), with the cookies the browser path sets. The row is
 * put together the way the browser path's handlers put it together — product, then the "About the
 * Store" seller merged with the store page (`mergeSellerPart`) — so a caller cannot tell the paths
 * apart, but for the seller's badges (see `scrapeProductOverHttp`).
 *
 * It gives up on anything the browser path handles better: a refusal or a challenge, a store page it
 * cannot read, data it has not been checked against. A product that does not exist is an answer
 * (`ITEM_NOT_FOUND`), not a reason to give up.
 */
export async function scrapeOverHttp(
    inputUrl: string,
    mode: CaptureMode,
    proxyUrl: string | undefined,
    log: Log,
): Promise<HttpPathOutcome> {
    // As the browser path: regional hosts are crawled on www, their subdomain kept as the ship-to country.
    const url = normalizeDhgateHost(inputUrl);
    const shipCountry = extractDhgateShipCountry(inputUrl);
    const client = createHttpClient({ proxyUrl, cookieHeader: localeCookieHeader(shipCountry) });

    if (mode === 'seller_only') {
        const store = await scrapeStoreOverHttp(url, client, log);
        return store.kind === 'seller' ? { row: sellerRow(inputUrl, mode, store.seller) } : { fallback: `store: ${store.reason}` };
    }

    // product_and_seller: the store is scraped alongside, from the moment the product page gives its link.
    // Set from the callback below — a holder, as TypeScript does not follow assignments made in callbacks.
    const pending: { store: Promise<StoreHttpResult> | null } = { store: null };
    const product = await scrapeProductOverHttp(url, shipCountry, client, log, (storeUrl) => {
        if (mode === 'product_and_seller') pending.store = scrapeStoreOverHttp(storeUrl, client, log);
    });
    if (product.kind === 'notFound') {
        log.warning(`[product] item not found — ${product.reason}`, { url });
        return { row: errorResponse(inputUrl, mode, 'ITEM_NOT_FOUND', product.reason) };
    }
    if (product.kind === 'failed') return { fallback: `product: ${product.reason}` };

    const response: ProductSellerResponse = { ...emptyResponse(inputUrl, mode), product: product.product };
    if (mode !== 'product_and_seller') return { row: response };

    // The seller as the product handler seeds it from the PDP, then merged with the store page.
    const inline = product.sellerInline;
    if (inline) {
        response.sellerRef = inline.ref;
        const seller = emptySeller();
        seller.platformSellerId = inline.ref.platformSellerId;
        seller.name = inline.ref.name;
        seller.url = inline.ref.url;
        seller.positiveFeedbackPercent = inline.positiveFeedbackPercent;
        seller.avatarUrl = inline.avatarUrl;
        seller.badges = inline.badges;
        response.seller = seller;
    }
    if (!pending.store) {
        log.warning('product_and_seller mode: no seller store URL found on PDP — pushing product only', { url });
        return { row: response };
    }
    const store = await pending.store;
    if (store.kind === 'failed') return { fallback: `store: ${store.reason}` };
    return { row: mergeSellerPart(response, sellerRow(inputUrl, mode, store.seller)) };
}
