import type { Page } from 'playwright';
import type { Pricing } from '../../dto/index.js';
import { emptyPricing } from '../../utils/defaults.js';
import { parseAmounts, parseCurrencySymbol, normalizeCurrency } from '../../utils/parse.js';

const PRICE_TIMEOUT_MILLIS = 30_000;

/**
 * Extract pricing.
 *
 * The price block has no `data-section` anchor and only hashed classes, but its
 * structure is stable: a single <b> holds the current price (a single value or a
 * range):
 *
 *   <div><b>US $14.9 - 20.0</b></div>
 *
 * We anchor on the <b> whose text looks like a price and read its value.
 * (Locators only — page.evaluate breaks under tsx/esbuild.)
 */
export async function extractPricing(page: Page): Promise<Pricing> {
    const pricing = emptyPricing();

    const priceLoc = page
        .locator('b')
        .filter({ hasText: /\$\s*[\d.,]+/ })
        .first();

    // The price block renders slightly later than the title, so wait for it.
    const waitStartedAt = Date.now();
    await priceLoc.waitFor({ state: 'visible', timeout: PRICE_TIMEOUT_MILLIS }).catch(() => {});
    // DHGate sometimes rewrites the URL to `?skuId=…&stockCountry=…` right after load. That navigation
    // ends the wait above early, with the price not found on a document that is going away. Wait for
    // the new one and look once more — only then: a wait that ran its full course found nothing.
    if ((await priceLoc.count()) === 0 && Date.now() - waitStartedAt < PRICE_TIMEOUT_MILLIS) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await priceLoc.waitFor({ state: 'visible', timeout: PRICE_TIMEOUT_MILLIS }).catch(() => {});
    }
    if ((await priceLoc.count()) === 0) return pricing;

    const currentText = (await priceLoc.textContent())?.trim() ?? null;

    // Current price may be a single value or a range ("US $14.9 - 20.0").
    const amounts = parseAmounts(currentText);
    if (amounts.length > 0) {
        pricing.priceMin = amounts[0];
        pricing.priceMax = amounts[amounts.length - 1];
    }

    pricing.currency = normalizeCurrency(parseCurrencySymbol(currentText));

    return pricing;
}
