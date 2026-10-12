import type { Page } from 'playwright';
import type { Pricing } from '../../dto/index.js';
import { emptyPricing } from '../../utils/defaults.js';
import { parseAmounts, parseCurrencySymbol, normalizeCurrency } from '../../utils/parse.js';

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
    await priceLoc.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
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
