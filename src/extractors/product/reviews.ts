import type { Page } from 'playwright';
import type { ReviewSample, RatingBreakdown } from '../../dto/index.js';

export const REVIEWS_API = 'https://www.dhgate.com/reviewbuyer/reviewOfProd/pageReviewOfProd';
/** Per call; a call the proxy hangs must not hold the product page's first read group. */
const REQUEST_TIMEOUT_MS = 10_000;
const ATTEMPTS_PER_STAR = 2;

export interface ReviewsResult {
    ratingBreakdown: RatingBreakdown;
    reviewSamples: ReviewSample[];
}

export interface RawReview {
    buyerNickname?: string;
    content?: string;
    score?: number;
    createdDateText?: string;
    reviewAttach?: { imgs?: { imgUrl?: string }[] | null } | null;
}

export function mapReview(raw: RawReview): ReviewSample {
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
 *
 * The five calls run in parallel: the star is a URL parameter of a JSON API, so they do not affect
 * each other (unlike the store's Review page, whose filter lives in the session). One after the other
 * and without a time limit, a single call hung by the proxy held the whole first read group for ~45 s.
 * Each call now gives up after {@link REQUEST_TIMEOUT_MS} and is asked once more; a star that still
 * fails is left at 0 with no samples, as before.
 */
export async function extractReviews(page: Page, itemCode: string, perStar = 5): Promise<ReviewsResult> {
    const ratingBreakdown: RatingBreakdown = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    const reviewSamples: ReviewSample[] = [];
    if (!itemCode) return { ratingBreakdown, reviewSamples };

    const scores = [1, 2, 3, 4, 5];
    const responses = await Promise.all(
        scores.map(async (score) => {
            const url =
                `${REVIEWS_API}?itemCode=${encodeURIComponent(itemCode)}&language=en&client=pc&dispCurrency=USD` +
                `&tagName=&sortType=1&pageNum=1&pageSize=${perStar}&isBot=&score=${score}&url_f=&url_r=`;
            for (let attempt = 0; attempt < ATTEMPTS_PER_STAR; attempt++) {
                const json = await fetchInPage(page, url);
                if (json?.state === '0x0000' && json.data) return json;
            }
            return null;
        }),
    );

    // Assembled in star order, as the one-after-the-other loop did.
    responses.forEach((json, index) => {
        if (!json?.data) return;
        ratingBreakdown[String(scores[index]) as keyof RatingBreakdown] = json.data.count ?? 0;
        const items = Array.isArray(json.data.data) ? json.data.data : [];
        for (const item of items.slice(0, perStar)) reviewSamples.push(mapReview(item));
    });

    return { ratingBreakdown, reviewSamples };
}

/** GET the API from inside the page, so Akamai sees a genuine same-origin browser request. `null` on any failure. */
async function fetchInPage(page: Page, url: string): Promise<ApiResponse | null> {
    // No named functions inside: `tsx` (esbuild) wraps them in `__name(...)`, which the page lacks.
    return (await page
        .evaluate(
            async ({ apiUrl, timeoutMs }) => {
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(), timeoutMs);
                try {
                    const r = await fetch(apiUrl, {
                        headers: { accept: 'application/json, text/plain, */*' },
                        credentials: 'include',
                        signal: ac.signal,
                    });
                    if (!r.ok) return null;
                    return await r.json();
                } catch {
                    return null;
                } finally {
                    clearTimeout(timer);
                }
            },
            { apiUrl: url, timeoutMs: REQUEST_TIMEOUT_MS },
        )
        .catch(() => null)) as ApiResponse | null;
}
