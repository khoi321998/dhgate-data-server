import { Actor } from 'apify';

import type {
    CaptureMode,
    Pricing,
    Product,
    ProductSellerResponse,
    ReviewsSummary,
    ScrapeErrorCode,
    Seller,
    Technical,
} from '../dto/index.js';
import { emptyExtractionReport } from '../extraction-audit.js';

export function emptyPricing(): Pricing {
    return {
        currency: 'USD',
        priceMin: null,
        priceMax: null,
    };
}

export function emptyReviewsSummary(): ReviewsSummary {
    return {
        rating: null,
        reviewCount: null,
        ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
        reviewSamples: [],
    };
}

/** A fully-defaulted Product. Handlers fill the fields they can scrape and leave the rest. */
export function emptyProduct(): Product {
    return {
        id: '',
        title: '',
        pricing: emptyPricing(),
        stock: { availableQuantity: null, soldCount: null },
        deliveryTimeText: null,
        paymentMethods: [],
        description: { html: '', plainText: '' },
        specifications: [],
        media: { images: [], videos: [] },
        reviewsSummary: emptyReviewsSummary(),
    };
}

/** A fully-defaulted Seller. Handlers fill the fields they can scrape and leave the rest. */
export function emptySeller(): Seller {
    return {
        platformSellerId: null,
        name: null,
        url: null,
        positiveFeedbackPercent: null,
        avatarUrl: null,
        transactions: null,
        badges: [],
        productPreviews: [],
        positiveReviewSamples: [],
        neutralReviewSamples: [],
        negativeReviewSamples: [],
    };
}

/**
 * The Apify run this process belongs to, or `null` when running locally — `apify run` has no
 * run behind it. Read on every call rather than cached at import time so it is never captured
 * before the SDK has populated the environment.
 */
export function currentActorRunId(): string | null {
    return Actor.getEnv().actorRunId ?? null;
}

/**
 * The response envelope every handler starts from: successful and empty until it says otherwise.
 *
 * `extraction` is a placeholder — {@link pushItem} overwrites it with the real audit right
 * before the row is pushed.
 */
export function emptyResponse(url: string, mode: CaptureMode): ProductSellerResponse {
    return {
        platform: 'dhgate',
        url,
        capturedAt: new Date().toISOString(),
        captureMode: mode,
        actorRunId: currentActorRunId(),
        success: true,
        errorCode: null,
        errorMessage: null,
        product: null,
        sellerRef: null,
        seller: null,
        extraction: emptyExtractionReport(),
    };
}

/**
 * An envelope for a page we could not scrape. `product`/`seller` stay null, which also keeps
 * the extraction audit quiet: its checks are gated on those sections being present, so a dead
 * listing is not reported as a broken selector.
 */
export function errorResponse(
    url: string,
    mode: CaptureMode,
    errorCode: ScrapeErrorCode,
    errorMessage: string,
): ProductSellerResponse {
    return { ...emptyResponse(url, mode), success: false, errorCode, errorMessage };
}

/** A fully-defaulted Technical block. Fields are populated as diagnostic scraping is added. */
export function emptyTechnical(): Technical {
    return {
        scriptBlocks: [],
        jsonState: {},
        dataAttributes: {},
        rawUrlParameters: {},
        experimentIds: [],
        trackingIds: { googleAnalytics: [], facebookPixel: [] },
        pageContext: { pageType: null, searchQuery: null, position: 0, listingType: null, campaignId: null },
        fulfilmentCodes: [],
        jsBundles: [],
        cssBundles: [],
        apiEndpoints: [],
    };
}
