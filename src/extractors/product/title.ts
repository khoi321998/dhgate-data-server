import type { Page } from 'playwright';

/**
 * Extract the product title.
 *
 * The title lives in the SectionProductTitle block. The wrapper classes
 * (e.g. ZMwbU2N, UiW2OOi) are hashed and change between builds, so we target
 * the stable `data-section` / `itemprop="name"` heading instead.
 *
 * Promotional badges (e.g. "Buyers' Picks", "New Buyer Discount") are rendered
 * as nested child elements inside the <h1>, while the real title is a direct
 * text node of the heading. We therefore read only the heading's direct text
 * nodes so any badge wrapped in a child element is excluded.
 */
export async function extractTitle(page: Page): Promise<string | null> {
    const locator = page.locator('[data-section="SectionProductTitle"] h1, h1[itemprop="name"]').first();
    await locator.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    if ((await locator.count()) === 0) return null;

    const title = await locator.evaluate((h1) =>
        Array.from(h1.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? '')
            .join('')
            .trim(),
    );

    // Fallback to full text content if the title isn't a direct text node.
    if (title) return title;
    return (await locator.textContent())?.trim() ?? null;
}
