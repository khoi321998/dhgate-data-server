import type { Page } from 'playwright';
import type {
    SellerReviewScore,
    SellerReviewSample,
    SellerReviewType,
    SellerServiceScore,
    SellerServiceScoreItem,
} from '../../dto/index.js';
import { settleCloudflareChallenge } from '../../utils/cloudflare.js';
import { stripUrlParams, parseCompactNumber, parseAmount } from '../../utils/parse.js';

/** Cap on how many seller reviews we keep per review type. */
const MAX_REVIEWS_PER_TYPE = 5;

/**
 * The "Reviews:" dropdown options we sample, with the `data-status` each one carries.
 * ("All" is `-2`; we skip it — the three buckets below already cover the list, and an
 * unfiltered sample is dominated by positives.)
 */
const REVIEW_TYPES: { type: SellerReviewType; status: string }[] = [
    { type: 'positive', status: '1' },
    { type: 'neutral', status: '0' },
    { type: 'negative', status: '-1' },
];

/** Review samples split by the "Reviews:" filter they were collected under. */
export type SellerReviewSamples = Record<SellerReviewType, SellerReviewSample[]>;

/** Everything read off the store's Review tab in a single navigation. */
export interface SellerFeedback {
    reviewScore: SellerReviewScore | null;
    /** Up to {@link MAX_REVIEWS_PER_TYPE} cards per review type. */
    reviews: SellerReviewSamples;
    /** "Service Detail Score" breakdown (Items as described, Communication, …). */
    serviceScore: SellerServiceScore | null;
    /** Positive review % from the review page header (fallback when the store header lacks it). */
    positiveFeedbackPercent: number | null;
    /** Transactions count from the review page header. */
    transactions: number | null;
}

/**
 * Navigate to the store's "Review" tab (linked as `a[spm-c="oncreview"]`) and read
 * both the feedback-score breakdown and the "Reviews Received" list in one go — they
 * live on the same server-rendered page.
 *
 * - `.review-score` table       -> Positive/Neutral/Negative totals (last cell per row)
 * - `.review-list-pro` (dl)     -> one review card each, sampled once per "Reviews:" filter
 *                                  (capped at {@link MAX_REVIEWS_PER_TYPE} per type)
 */
export async function extractSellerFeedback(page: Page): Promise<SellerFeedback> {
    const empty: SellerFeedback = {
        reviewScore: null,
        reviews: { positive: [], neutral: [], negative: [] },
        serviceScore: null,
        positiveFeedbackPercent: null,
        transactions: null,
    };

    // DHGate reuses spm-c="oncreview" for BOTH the "Store Membership" and the real
    // "Review" nav links, so the bare attribute + .first() lands on Membership.
    // Disambiguate by the seller-feedback href, which only the Review link carries.
    const reviewLink = page.locator('a[spm-c="oncreview"][href*="seller-feedback"]').first();
    if ((await reviewLink.count()) === 0) return empty;
    const reviewUrl = stripUrlParams(await reviewLink.getAttribute('href'));
    if (!reviewUrl) return empty;

    // 'commit' instead of 'domcontentloaded': the review data is server-rendered, but the
    // page's trailing inline scripts delay DOMContentLoaded. The per-section reads below
    // (waitFor on .review-score, etc.) gate on the actual data instead.
    await page.goto(reviewUrl, { waitUntil: 'commit' }).catch(() => {});
    // Our own navigation, so server.ts's post-navigation hook never runs for it: without this a
    // Cloudflare interstitial on the Review tab reads as a store with no feedback at all.
    await settleCloudflareChallenge(page);

    // Read the page-level blocks first: sampling the reviews re-submits the page's filter
    // form, so everything else must come off the copy we already have.
    const stats = await extractFeedbackStats(page);
    const reviewScore = await extractReviewScore(page);
    const serviceScore = await extractServiceScore(page);

    return {
        reviewScore,
        serviceScore,
        reviews: await extractReviewSamples(page),
        positiveFeedbackPercent: stats.positiveFeedbackPercent,
        transactions: stats.transactions,
    };
}

/**
 * Parse the review page's `.seller-information-warp .feedback-info` block:
 *   <li><strong>30,479</strong><span>Transactions</span></li>
 *   <li><strong>96.5%</strong><span>Positive Review</span></li>
 */
async function extractFeedbackStats(
    page: Page,
): Promise<{ positiveFeedbackPercent: number | null; transactions: number | null }> {
    let positiveFeedbackPercent: number | null = null;
    let transactions: number | null = null;
    // We navigate with waitUntil:'commit', so wait for the block to parse before reading.
    const warp = page.locator('.seller-information-warp').first();
    await warp.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    for (const li of await page.locator('.seller-information-warp .feedback-info li').all()) {
        const label = await readText(li.locator('span').first());
        const value = await readText(li.locator('strong').first());
        if (/positive/i.test(label)) positiveFeedbackPercent ??= parseAmount(value);
        else if (/transaction/i.test(label)) transactions ??= parseCompactNumber(value);
    }
    return { positiveFeedbackPercent, transactions };
}

/**
 * Parse the `.review-score` table, keeping only the "Total" column for each sentiment.
 * Rows are tagged by an inner `.a1`/`.a2`/`.a3` div; the Total is the row's last cell.
 */
async function extractReviewScore(page: Page): Promise<SellerReviewScore | null> {
    const table = page.locator('.review-score').first();
    await table.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    if ((await table.count()) === 0) return null;

    const [positive, neutral, negative] = await Promise.all([
        totalFor(table, '.a1'),
        totalFor(table, '.a2'),
        totalFor(table, '.a3'),
    ]);

    if (positive == null && neutral == null && negative == null) return null;
    return { positive, neutral, negative };
}

/** Read the last cell (Total column) of the row whose label cell matches `marker`. */
async function totalFor(table: ReturnType<Page['locator']>, marker: string): Promise<number | null> {
    const cell = table.locator(`tr:has(${marker}) td:last-child`).first();
    if ((await cell.count()) === 0) return null;
    return parseCompactNumber(await readText(cell));
}

/**
 * Parse the "Service Detail Score" table (`.service-score`):
 *   <div class="bt">Service Detail Score <b class="review-style">(Mainly Industry : Pet Supplies)</b></div>
 *   <table class="list"> ... one <tr> per aspect (Items as described, Communication, …) </table>
 *
 * Each data row (skipping the `.fbt` header row) has four cells:
 *   [0] detail name  [1] score (`.jdt[title]` + "4.9 / 5.0" text)  [2] vs industry  [3] # of ratings.
 * We keep the detail name, score, and number of ratings.
 */
async function extractServiceScore(page: Page): Promise<SellerServiceScore | null> {
    const block = page.locator('.service-score').first();
    await block.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    if ((await block.count()) === 0) return null;

    const industry = parseIndustry(await readText(block.locator('.bt .review-style').first()));

    const items: SellerServiceScoreItem[] = [];
    for (const row of await block.locator('table.list tr').all()) {
        // Skip the header row (`.fbt`), which has no `.jdt` score cell.
        if ((await row.locator('.jdt').count()) === 0) continue;
        const cells = row.locator('td');
        if ((await cells.count()) < 4) continue;

        const detail = (await readText(cells.nth(0))) || null;
        // Prefer the `.jdt` div's title ("4.9"); fall back to the visible "4.9 / 5.0" text.
        const score =
            parseAmount(await readAttr(row.locator('.jdt').first(), 'title')) ??
            parseAmount(await readText(cells.nth(1)));
        const numberOfRatings = parseCompactNumber(await readText(cells.nth(3)));

        items.push({ detail, score, numberOfRatings });
    }

    if (items.length === 0) return null;
    return { industry, items };
}

/** Pull the industry out of "(Mainly Industry : Pet Supplies)" -> "Pet Supplies". */
function parseIndustry(text: string): string | null {
    if (!text) return null;
    const match = text.match(/industry\s*:\s*([^)]+)/i);
    return match ? match[1].trim() : null;
}

/**
 * Walk the "Reviews:" dropdown — Positive, then Neutral, then Negative — and keep the first
 * {@link MAX_REVIEWS_PER_TYPE} cards of each. Without this the list is whatever DHGate
 * preselects (Positive), so a store's negatives never made it into the sample.
 */
async function extractReviewSamples(page: Page): Promise<SellerReviewSamples> {
    const reviews: SellerReviewSamples = { positive: [], neutral: [], negative: [] };
    for (const { type, status } of REVIEW_TYPES) {
        // A filter we cannot switch to is left empty rather than sampled: re-reading the list
        // would just file the previous type's cards under the wrong one.
        if (!(await selectReviewType(page, status))) continue;
        reviews[type] = await extractReviews(page);
    }
    return reviews;
}

/**
 * Pick one option from the `.review-type-option` dropdown ("Reviews: Positive/Neutral/…").
 *
 * The option's handler writes `data-status` into the hidden `#score` input and submits
 * `SellerscoreActionForm`, so the page reloads filtered. Returns false when the dropdown is
 * missing or the reload did not take, so the caller can skip that bucket.
 */
async function selectReviewType(page: Page, status: string): Promise<boolean> {
    const score = page.locator('#score').first();
    await score.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    if ((await score.count()) === 0) return false;
    // DHGate opens the tab on "Positive", so the first pass usually needs no round trip.
    if ((await score.inputValue().catch(() => null)) === status) return true;

    const option = page.locator(`.review-type-option a[data-status="${status}"]`).first();
    if ((await option.count()) === 0) return false;

    // The list is collapsed until its label is clicked.
    if (!(await option.isVisible().catch(() => false))) {
        await page
            .locator('.review-search-con .j-inb-statustxt')
            .first()
            .click({ timeout: 5_000 })
            .catch(() => {});
    }

    // Wait on the navigation, not on `#score`: the handler sets the input *before* submitting,
    // so the new value is readable on the old document and would let us read a stale list.
    const navigated = page.waitForNavigation({ waitUntil: 'commit', timeout: 15_000 }).catch(() => null);
    await option.click({ timeout: 5_000 }).catch(() => {});
    await navigated;

    await score.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    return (await score.inputValue().catch(() => null)) === status;
}

/**
 * Parse the "Reviews Received" list (`.review-list-pro` cards) currently on the page,
 * capped at MAX_REVIEWS_PER_TYPE. Which filter is active is the caller's business.
 */
async function extractReviews(page: Page): Promise<SellerReviewSample[]> {
    // The wrapper renders even when the filter matches nothing, so gate on it rather than on
    // the cards — an empty Negative bucket must not cost a 10s timeout.
    await page.locator('.review-new-warp').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});

    const cards = page.locator('.review-list-pro');
    if ((await cards.count()) === 0) return [];

    const reviews: SellerReviewSample[] = [];
    for (const card of await cards.all()) {
        if (reviews.length >= MAX_REVIEWS_PER_TYPE) break;

        const user = (await readText(card.locator('.user-info p').first())).replace(/^By:\s*/i, '') || null;
        const country = (await readText(card.locator('.review-country .country').first())) || null;
        const rating = ratingFromWidth(await readAttr(card.locator('.review-list-rate b').first(), 'style'));
        const reviewDate = (await readText(card.locator('.review-list-time').first())) || null;
        const comment = (await readText(card.locator('dd p').first())) || null;
        const helpfulCount = parseCompactNumber(await readText(card.locator('.review-text1').first()));
        const unhelpfulCount = parseUnhelpful(await readText(card.locator('.review-text3').last()));

        reviews.push({ user, country, rating, reviewDate, comment, helpfulCount, unhelpfulCount });
    }

    return reviews;
}

/**
 * Parse a 0–5 star rating from the rating bar's fill width.
 * `<b style="width:100%;">` == 5 stars, so `rating = percent / 20`.
 */
function ratingFromWidth(style: string | null): number | null {
    if (!style) return null;
    const match = style.match(/width:\s*([\d.]+)%/i);
    if (!match) return null;
    const percent = parseFloat(match[1]);
    return Number.isFinite(percent) ? Math.round((percent / 20) * 10) / 10 : null;
}

/** Pull the count out of "unhelpful ( 0 )". */
function parseUnhelpful(text: string): number | null {
    const match = text.match(/unhelpful\s*\(\s*([\d.,]+)/i);
    return match ? parseCompactNumber(match[1]) : null;
}

/** Read trimmed text content from a locator, returning '' when the element is absent. */
async function readText(loc: ReturnType<Page['locator']>): Promise<string> {
    if ((await loc.count()) === 0) return '';
    return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

/** Read an attribute from a locator, returning null when the element is absent. */
async function readAttr(loc: ReturnType<Page['locator']>, name: string): Promise<string | null> {
    if ((await loc.count()) === 0) return null;
    return await loc.getAttribute(name);
}
