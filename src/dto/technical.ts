export interface TrackingIds {
    googleAnalytics: string[];
    facebookPixel: string[];
}

export interface PageContext {
    pageType: string | null;
    searchQuery: string | null;
    position: number;
    listingType: string | null;
    campaignId: string | null;
}

/** Raw / diagnostic signals harvested from the page for debugging & enrichment. */
export interface Technical {
    scriptBlocks: string[];
    jsonState: Record<string, unknown>;
    dataAttributes: Record<string, unknown>;
    rawUrlParameters: Record<string, string>;
    experimentIds: string[];
    trackingIds: TrackingIds;
    pageContext: PageContext;
    fulfilmentCodes: string[];
    jsBundles: string[];
    cssBundles: string[];
    apiEndpoints: string[];
}

/** Technical signals specific to the seller page (when captured). */
export type SellerTechnical = Technical;
