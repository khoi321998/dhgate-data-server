import type { ProductSellerResponse, Seller } from './dto/index.js';
import { emptySeller } from './utils/defaults.js';

/**
 * Merge the store-page row into the product row, for `product_and_seller`. The precedence is the one
 * the Actor's seller handler applied to the product row it was handed: identity comes off the PDP and
 * the store page only fills its gaps; stats, previews, about and reviews come off the store page and
 * the PDP is the fallback.
 */
export function mergeSellerPart(productRow: ProductSellerResponse, sellerRow: ProductSellerResponse): ProductSellerResponse {
    const merged = productRow;

    // The store page is gone or never loaded: keep the product and the PDP's inline seller, and report
    // only the seller as missing.
    if (!sellerRow.success || !sellerRow.seller) {
        merged.success = false;
        merged.errorCode = sellerRow.errorCode;
        merged.errorMessage = sellerRow.errorMessage;
        return merged;
    }

    const store = sellerRow.seller;
    const seller: Seller = merged.seller ?? emptySeller();
    seller.url ??= store.url;
    seller.productPreviews = store.productPreviews;
    seller.name ??= store.name;
    seller.platformSellerId ??= store.platformSellerId;
    seller.avatarUrl ??= store.avatarUrl;
    if (seller.badges.length === 0) seller.badges = store.badges;
    seller.positiveFeedbackPercent = store.positiveFeedbackPercent ?? seller.positiveFeedbackPercent;
    seller.transactions = store.transactions ?? seller.transactions;
    if (store.about) seller.about = store.about;
    if (store.reviewScore) seller.reviewScore = store.reviewScore;
    if (store.serviceScore) seller.serviceScore = store.serviceScore;
    if (store.positiveReviewSamples?.length) seller.positiveReviewSamples = store.positiveReviewSamples;
    if (store.neutralReviewSamples?.length) seller.neutralReviewSamples = store.neutralReviewSamples;
    if (store.negativeReviewSamples?.length) seller.negativeReviewSamples = store.negativeReviewSamples;

    merged.seller = seller;
    merged.sellerRef ??= { platformSellerId: seller.platformSellerId, name: seller.name, url: seller.url };
    return merged;
}
