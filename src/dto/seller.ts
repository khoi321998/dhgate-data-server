/** Lightweight pointer to a seller (id/handle) without the full profile. */
export interface SellerRef {
    platformSellerId: string | null;
    name: string | null;
    url: string | null;
}

/**
 * A lightweight preview of one of the seller's other products, scraped from the PDP's
 * "Recommended from <store>" strip.
 *
 * Every field is optional: keys whose value is missing on the card (e.g. no rating bar,
 * no original/list price) are omitted from the output object rather than emitted as null.
 */
export interface SellerProductPreview {
    productId?: string;
    title?: string;
    url?: string;
    imageUrl?: string;
    price?: number;
    originalPrice?: number;
    originalPriceText?: string;
    /** Discount magnitude as a positive percentage (e.g. 50 for "-50%"). */
    discountPercent?: number;
    /** Star rating 0–5, derived from the rating bar's fill width. */
    rating?: number;
    /** Number of reviews shown next to the rating. */
    reviewCount?: number;
}

/** Which bucket of the Review tab's "Reviews:" dropdown a sample was collected from. */
export type SellerReviewType = 'positive' | 'neutral' | 'negative';

/**
 * A single review from the store's "Reviews Received" list on the Review tab.
 * Which filter it came from is carried by the field it lands in, not by the sample.
 */
export interface SellerReviewSample {
    /** Reviewer's masked display name, e.g. "Laura****hetta" ("By:" stripped). */
    user: string | null;
    /** ISO-3166 country code of the reviewer, e.g. "US". */
    country: string | null;
    /** Star rating 0–5, derived from the rating bar's fill width. */
    rating: number | null;
    /** Date shown on the review, e.g. "06 11,2026". */
    reviewDate: string | null;
    comment: string | null;
    helpfulCount: number | null;
    unhelpfulCount: number | null;
}

/**
 * Extra seller info scraped from the store's "About Us" tab (Basic Information +
 * store introduction). Every field is optional: empty rows on the page are omitted.
 */
export interface SellerAbout {
    /** Store introduction / welcome text shown on the About Us page. */
    introduction?: string;
    companyName?: string;
    businessType?: string;
    location?: string;
    /** When the store opened, e.g. "Mar 2025". */
    yearEstablished?: string;
    /** The "Main Product(s)/Service" value. */
    mainProducts?: string;
}

/** Seller feedback breakdown (Total column) from the store's Review page. */
export interface SellerReviewScore {
    positive: number | null;
    neutral: number | null;
    negative: number | null;
}

/** One row of the "Service Detail Score" table on the store's Review page. */
export interface SellerServiceScoreItem {
    /** Service aspect, e.g. "Items as described", "Communication". */
    detail: string | null;
    /** Score 0–5, e.g. 4.9. */
    score: number | null;
    /** Number of ratings the aspect is based on, e.g. 6078. */
    numberOfRatings: number | null;
}

/** The store's "Service Detail Score" block from the Review page. */
export interface SellerServiceScore {
    /** Industry the scores are benchmarked against, e.g. "Pet Supplies". */
    industry: string | null;
    /** One entry per service aspect (Items as described, Communication, …). */
    items: SellerServiceScoreItem[];
}

/** Full seller profile. Shape extends as more seller fields are scraped. */
export interface Seller {
    platformSellerId: string | null;
    name: string | null;
    url: string | null;
    positiveFeedbackPercent: number | null;
    /** Store avatar/logo image URL. */
    avatarUrl: string | null;
    /** Total transactions count shown on the store header's feedback panel. */
    transactions: number | null;
    /** Tooltip labels of the store's badges (tier, Trade Assurance, "1st year", …). */
    badges: string[];
    /** Positive/neutral/negative feedback totals from the store's Review page. */
    reviewScore?: SellerReviewScore;
    /** "Service Detail Score" breakdown (Items as described, Communication, …) from the Review page. */
    serviceScore?: SellerServiceScore;
    /** Extra info from the store's "About Us" tab (Basic Information + introduction). */
    about?: SellerAbout;
    /** Other products by this seller, scraped from the PDP recommendation strip. */
    productPreviews?: SellerProductPreview[];
    /**
     * Store review samples, one field per "Reviews:" filter on the Review tab, up to 5 each.
     * The tab's Dates filter stays on its default (Last 30 days), so a quiet bucket is
     * legitimately empty rather than a sign of a broken selector.
     */
    positiveReviewSamples?: SellerReviewSample[];
    neutralReviewSamples?: SellerReviewSample[];
    negativeReviewSamples?: SellerReviewSample[];
    [key: string]: unknown;
}
