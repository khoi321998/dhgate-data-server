import type { Page } from 'playwright';
import { parseAmount, parseCompactNumber, normalizeImageUrl } from '../../utils/parse.js';

/** Identity + headline stats read from the store page header. */
export interface SellerHeaderStats {
    name: string | null;
    avatarUrl: string | null;
    badges: string[];
    positiveFeedbackPercent: number | null;
    transactions: number | null;
}

/**
 * Extract the seller's identity + headline stats from the store page header.
 *
 * The store header uses the legacy storefront template (stable class names, unlike the
 * hashed React PDP), so anchor on those plus the stable `spm-c` feedback links:
 * - `.sto-name`                    -> store name ("LuggageStride")
 * - `.storelogo img`               -> store logo / avatar
 * - `.seller-identification span[title]` -> badge tooltips (tier, etc.)
 * - `a[spm-c="positive feedback"]` -> "94.9%"  (positive feedback percentage)
 * - `a[spm-c="Transactions"]`      -> "4973"   (total transactions)
 *
 * In `seller_only` runs this is the ONLY source of the seller's name/avatar/badges
 * (there's no PDP "About the Store" block to read them from).
 */
export async function extractSellerHeader(page: Page): Promise<SellerHeaderStats> {
    const nameLoc = page.locator('.sto-name').first();
    const name = (await readText(nameLoc)) || (await readAttr(nameLoc, 'title')) || null;
    const avatarUrl = normalizeImageUrl(await readAttr(page.locator('.storelogo img').first(), 'src'));

    const badges: string[] = [];
    for (const el of await page.locator('.seller-identification span[title]').all()) {
        const title = (await el.getAttribute('title'))?.trim();
        if (title && !badges.includes(title)) badges.push(title);
    }

    const feedbackText = await readText(page.locator('a[spm-c="positive feedback"]').first());
    const transactionsText = await readText(page.locator('a[spm-c="Transactions"]').first());

    return {
        name: name?.trim() || null,
        avatarUrl,
        badges,
        positiveFeedbackPercent: parseAmount(feedbackText),
        transactions: parseCompactNumber(transactionsText),
    };
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
