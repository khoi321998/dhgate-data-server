import type { Platform, CaptureMode, ScrapeErrorCode } from './common.js';
import type { ExtractionReport } from './extraction.js';
import type { Product } from './product.js';
import type { SellerRef, Seller } from './seller.js';
import type { Technical, SellerTechnical } from './technical.js';

/** The top-level object pushed to the dataset for each crawled URL. */
export interface ProductSellerResponse {
    platform: Platform;
    url: string;
    /** ISO-8601 timestamp of when the page was captured. */
    capturedAt: string;
    captureMode: CaptureMode;
    /**
     * The Apify run that produced this row, so a dataset item can be traced back to its run (and
     * its logs) without going through the dataset's own metadata. `null` when running locally,
     * where there is no run.
     */
    actorRunId: string | null;
    /**
     * Whether this row captured everything the capture mode asked for. A failure is still pushed
     * as a row rather than dropped — the caller asked about this URL and deserves an answer about
     * it — so `success` is the first thing a consumer should branch on.
     *
     * `false` does not always mean empty: a `product_and_seller` row whose store page is gone
     * keeps the product it did scrape and reports `SELLER_NOT_FOUND`.
     */
    success: boolean;
    /** Machine-readable failure reason, `null` when `success` is `true`. */
    errorCode: ScrapeErrorCode | null;
    /** Human-readable detail behind `errorCode`: which signal fired. `null` on success. */
    errorMessage: string | null;
    /** The scraped product, or `null` in `seller_only` runs (no product page is visited). */
    product: Product | null;
    sellerRef: SellerRef | null;
    seller: Seller | null;
    /**
     * Health of this row's extraction: which fields we expected to find were actually there.
     * Filled in by {@link pushItem} immediately before the row is pushed — a `status` other
     * than `ok` usually means a DHGate markup change broke a selector.
     */
    extraction: ExtractionReport;
    // Temporarily disabled — not emitted to the dataset for now. Kept optional so the
    // diagnostic blocks can be re-enabled without changing the contract.
    technical?: Technical;
    sellerTechnical?: SellerTechnical | null;
}
