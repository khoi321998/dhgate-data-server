export interface Pricing {
    currency: string;
    priceMin: number | null;
    priceMax: number | null;
}

export interface Stock {
    availableQuantity: number | null;
    soldCount: number | null;
}

export interface Description {
    html: string;
    plainText: string;
}

export interface Specification {
    name: string;
    value: string;
}

export interface ProductImage {
    url: string;
}

export interface ProductVideo {
    url: string;
    poster?: string | null;
}

export interface Media {
    images: ProductImage[];
    videos: ProductVideo[];
}

/** Count of reviews per star value, keyed "1".."5". */
export interface RatingBreakdown {
    '1': number;
    '2': number;
    '3': number;
    '4': number;
    '5': number;
}

export interface ReviewSample {
    user: string;
    userFeedbackScore: number | null;
    comment: string;
    /** Free-text recency label as shown on the page, e.g. "Past 6 months". */
    commentDate: string;
    /** Star rating of this individual review (1–5), when shown. */
    rating: number | null;
    verifiedPurchase: boolean;
    /** Buyer-uploaded photo URLs attached to this review. */
    images: string[];
}

export interface ReviewsSummary {
    rating: number | null;
    reviewCount: number | null;
    ratingBreakdown: RatingBreakdown;
    /** Sample reviews as shown on the page, each carrying its own star `rating`. */
    reviewSamples: ReviewSample[];
}

export interface Product {
    /** The marketplace's native item identifier (DHGate product id). */
    id: string;
    title: string;
    pricing: Pricing;
    stock: Stock;
    /** Free-text delivery estimate shown in the buy box, e.g. "15 Days Delivery". */
    deliveryTimeText: string | null;
    /** Accepted payment method logo URLs, as shown in the "Buyer Protection" modal. */
    paymentMethods: string[];
    description: Description;
    specifications: Specification[];
    media: Media;
    reviewsSummary: ReviewsSummary;
}
