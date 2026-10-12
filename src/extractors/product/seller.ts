import type { Page } from 'playwright';
import type { SellerRef } from '../../dto/index.js';
import { extractSellerId, stripUrlParams, normalizeImageUrl, parseAmount } from '../../utils/parse.js';

/** Seller data read inline from the PDP's "About the Store" block (no navigation). */
export interface SellerInline {
    ref: SellerRef;
    positiveFeedbackPercent: number | null;
    avatarUrl: string | null;
    badges: string[];
}

/**
 * Extract the seller reference + headline stats from the PDP's "About the Store"
 * block (`div[spm-c="soldby"]`). Returns `null` when the block is absent.
 *
 * Anchors on the stable `spm-*` attributes (the surrounding classes are hashed):
 * - `a[spm-index="store"]`  -> store URL (+ id) and, via its `<b>`, the store name
 * - `a[spm-index="store"] img` -> avatar (and `alt` as a name fallback)
 * - `.LyovOX6 span`         -> "<b>96.4%</b> Positive Feedback" / "<b>30426</b> Orders"
 * - `span[title]`           -> badge tooltips (Trade Assurance, Top Superior, tier, "1st year"…)
 */
export async function extractSellerInline(page: Page): Promise<SellerInline | null> {
    // "About the Store" sits low on the PDP and mounts lazily — scroll to the bottom
    // so React renders it, then wait for it to attach before reading.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    // The PDP renders several [spm-c="soldby"] containers (tracking/exposure
    // wrappers alongside the real "About the Store" card), and the card is not
    // always first in document order. Anchor on the soldby block that actually
    // contains the store link rather than blindly taking .first() — otherwise we
    // pick an empty wrapper and report "no seller store URL" while the link is
    // sitting in a sibling block. The has-filter also makes waitFor block until
    // the lazily-mounted store link is present.
    const block = page.locator('[spm-c="soldby"]', { has: page.locator('a[spm-index="store"]') }).first();
    await block.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    if ((await block.count()) === 0) return null;
    await block.scrollIntoViewIfNeeded().catch(() => {});

    const storeLink = block.locator('a[spm-index="store"]').first();
    if ((await storeLink.count()) === 0) return null;

    const rawHref = await storeLink.getAttribute('href');
    const url = stripUrlParams(rawHref);
    const platformSellerId = extractSellerId(rawHref);

    // Name: prefer the bold store name; fall back to the avatar img `alt`.
    const avatarImg = block.locator('a[spm-index="store"] img').first();
    const hasAvatar = (await avatarImg.count()) > 0;
    let name = (await readText(block.locator('a[spm-index="store"] b').first())) || null;
    if (!name && hasAvatar) name = (await avatarImg.getAttribute('alt'))?.trim() || null;
    const avatarUrl = hasAvatar ? normalizeImageUrl(await avatarImg.getAttribute('src')) : null;

    // Stats row: spans such as "<b>96.4%</b> Positive Feedback".
    let positiveFeedbackPercent: number | null = null;
    for (const stat of await block.locator('.LyovOX6 span').all()) {
        const text = await readText(stat);
        if (/positive feedback/i.test(text)) positiveFeedbackPercent ??= parseAmount(text);
    }

    // Badges: the tooltip titles on the marker spans (tier, Trade Assurance, "1st year", …).
    const badges: string[] = [];
    for (const el of await block.locator('span[title]').all()) {
        const title = (await el.getAttribute('title'))?.trim();
        if (title && !badges.includes(title)) badges.push(title);
    }

    return {
        ref: { platformSellerId, name, url },
        positiveFeedbackPercent,
        avatarUrl,
        badges,
    };
}

/** Read trimmed text content from a locator, returning '' when the element is absent. */
async function readText(loc: ReturnType<Page['locator']>): Promise<string> {
    if ((await loc.count()) === 0) return '';
    return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}
