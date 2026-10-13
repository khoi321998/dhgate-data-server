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
    // DHGate rewrites the URL to `?skuId=…` (and `&stockCountry=…`) right after load — sometimes
    // twice — and each rewrite can end a wait early, with the price not yet rendered. So the wait is
    // picked up again after every early end, until the price shows or the budget is spent.
    const deadline = Date.now() + PRICE_TIMEOUT_MILLIS;
    while ((await priceLoc.count()) === 0 && Date.now() < deadline) {
        await priceLoc.waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
        if ((await priceLoc.count()) === 0) await page.waitForTimeout(250).catch(() => {});
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
