import type { Page } from 'playwright';
import { parseAmount, parseCompactNumber } from '../../utils/parse.js';

export interface HeadlineStats {
    rating: number | null;
    reviewCount: number | null;
    soldCount: number | null;
}

/**
 * Extract the headline stats shown under the title: star rating, review count,
 * and sold count.
 *
 * Anchors (stable across builds, unlike the hashed classes):
 * - rating:      `#starLevel`            -> textContent "4.7"
 * - reviewCount: `[spm-index="comment"]` -> "(3970 Reviews)"
 * - soldCount:   `[spm-index="freight"]` -> "5K+ sold"
 */
export async function extractHeadlineStats(page: Page): Promise<HeadlineStats> {
    const stats: HeadlineStats = { rating: null, reviewCount: null, soldCount: null };

    const ratingLoc = page.locator('#starLevel');
    if ((await ratingLoc.count()) > 0) {
        const value = parseFloat(((await ratingLoc.first().textContent()) ?? '').trim());
        stats.rating = Number.isFinite(value) ? value : null;
    }

    const reviewLoc = page.locator('[spm-index="comment"]').first();
    if ((await reviewLoc.count()) > 0) {
        stats.reviewCount = parseAmount(await reviewLoc.textContent());
    }

    const soldLoc = page.locator('[spm-index="freight"]').first();
    if ((await soldLoc.count()) > 0) {
        stats.soldCount = parseCompactNumber(await soldLoc.textContent());
    }

    return stats;
}
