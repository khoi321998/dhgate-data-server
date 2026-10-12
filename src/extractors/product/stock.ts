import type { Page } from 'playwright';
import { parseCompactNumber } from '../../utils/parse.js';

/**
 * Extract the available quantity from the "<n> in stock" label next to the
 * quantity stepper. The surrounding classes are hashed, so we anchor on the
 * "in stock" text itself and parse the leading number ("1 in stock" -> 1).
 *
 * The label first renders a "0 in stock" placeholder and is updated to the real
 * value once the SKU data loads, so we poll briefly until it stabilises. A value
 * that genuinely stays 0 (out of stock) is returned as 0 after the poll window.
 *
 * Many listings (e.g. size-variant apparel/shoes) never render an "in stock" label
 * at all, so the wait below is kept short: by the time extractors run the page is
 * already loaded, and if the label exists it appears almost immediately. A long
 * timeout here would just stall every request that legitimately lacks the label.
 */
export async function extractAvailableQuantity(page: Page): Promise<number | null> {
    const loc = page
        .locator('span')
        .filter({ hasText: /in stock/i })
        .first();
    await loc.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if ((await loc.count()) === 0) return null;

    let value = parseCompactNumber(await loc.textContent());
    // Poll up to ~3s for the placeholder 0 to be replaced by the real quantity.
    for (let i = 0; i < 6 && (value === null || value === 0); i++) {
        await page.waitForTimeout(500);
        value = parseCompactNumber(await loc.textContent());
    }
    return value;
}
