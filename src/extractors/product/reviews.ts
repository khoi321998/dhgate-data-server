import type { Page } from 'playwright';
import type { ReviewSample, RatingBreakdown } from '../../dto/index.js';

const REVIEWS_API = 'https://www.dhgate.com/reviewbuyer/reviewOfProd/pageReviewOfProd';

export interface ReviewsResult {
    ratingBreakdown: RatingBreakdown;
    reviewSamples: ReviewSample[];
}

interface RawReview {
    buyerNickname?: string;
    content?: string;
    score?: number;
    createdDateText?: string;
    reviewAttach?: { imgs?: { imgUrl?: string }[] | null } | null;
}

function mapReview(raw: RawReview): ReviewSample {
    const images = (raw.reviewAttach?.imgs ?? [])
        .map((i) => i.imgUrl)
        .filter((u): u is string => typeof u === 'string');

    return {
        user: raw.buyerNickname ?? '',
        userFeedbackScore: null,
        comment: raw.content ?? '',
        commentDate: raw.createdDateText ?? '',
        rating: typeof raw.score === 'number' ? raw.score : null,
        verifiedPurchase: false, // DHGate's review API exposes no reliable verified flag
        images,
    };
}

interface ApiResponse {
    state?: string;
    data?: { count?: number; data?: RawReview[] };
}

/**
 * Fetch product reviews via DHGate's public review API.
 *
 * The request MUST be made from inside the real browser page (`page.evaluate` +
 * fetch): DHGate is behind Akamai, which 403s a node-side HTTP client (Playwright's
 * context.request) because of its TLS/header fingerprint, but allows the genuine
 * browser's same-origin XHR (real Akamai cookies + fingerprint).
 *
 * Calls the endpoint once per star (score=1..5), taking up to `perStar` samples
 * each, and records every star's total `count` as the rating breakdown.
 */
export async function extractReviews(page: Page, itemCode: string, perStar = 5): Promise<ReviewsResult> {
    const ratingBreakdown: RatingBreakdown = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    const reviewSamples: ReviewSample[] = [];
    if (!itemCode) return { ratingBreakdown, reviewSamples };

    for (let score = 1; score <= 5; score++) {
        const url =
            `${REVIEWS_API}?itemCode=${encodeURIComponent(itemCode)}&language=en&client=pc&dispCurrency=USD` +
            `&tagName=&sortType=1&pageNum=1&pageSize=${perStar}&isBot=&score=${score}&url_f=&url_r=`;
        try {
            // Run fetch in the page so Akamai sees a genuine same-origin browser request.
            const json = (await page.evaluate(async (apiUrl) => {
                const r = await fetch(apiUrl, {
                    headers: { accept: 'application/json, text/plain, */*' },
                    credentials: 'include',
                });
                if (!r.ok) return null;
                return r.json();
            }, url)) as ApiResponse | null;

            if (!json || json.state !== '0x0000' || !json.data) continue;

            ratingBreakdown[String(score) as keyof RatingBreakdown] = json.data.count ?? 0;
            const items = Array.isArray(json.data.data) ? json.data.data : [];
            for (const item of items.slice(0, perStar)) reviewSamples.push(mapReview(item));
        } catch {
            // Skip this star on network/parse error; keep whatever else succeeded.
        }
    }

    return { ratingBreakdown, reviewSamples };
}
