import type { Page } from 'playwright';

/**
 * Extract the PDP delivery estimate (the free-text "Estimated delivery time" the
 * buy box shows for the default shipping option).
 *
 * The block lives in a `[spm-c="soldby"]` container with hashed React classes, so we
 * anchor on the stable `spm-index="shipping"` row and read by DOM structure rather
 * than class names:
 *
 *   [spm-index="shipping"]  <div>Estimated delivery time:<span>15 Days Delivery</span>…</div>
 *
 * Uses locators (not page.evaluate) so it works under both the tsx dev runner and the
 * compiled build. Returns null when the row is absent.
 */
export async function extractDeliveryTimeText(page: Page): Promise<string | null> {
    const blocks = page.locator('[spm-index="shipping"]');
    await blocks
        .first()
        .waitFor({ state: 'attached', timeout: 8_000 })
        .catch(() => {});
    if ((await blocks.count()) === 0) return null;

    // Route row: "To <dest> Via <method>" then "Estimated delivery time: <text> <tooltip>".
    const routeBlock = page.locator('[spm-index="shipping"]', { hasText: 'Estimated delivery' }).first();
    if ((await routeBlock.count()) === 0) return null;

    const rows = routeBlock.locator(':scope > div');
    const deliveryRow = rows.nth(1);
    return (await readText(deliveryRow.locator('span').first())) || null;
}

/** Read trimmed text content from a locator, returning '' when the element is absent. */
async function readText(loc: ReturnType<Page['locator']>): Promise<string> {
    if ((await loc.count()) === 0) return '';
    return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}
