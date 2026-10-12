import type { Page } from 'playwright';
import type { Specification } from '../../dto/index.js';

/**
 * Extract the product specifications.
 *
 * They live in `section[data-section="SectionProductSpecifications"]` as a <dl>
 * of alternating `<dt><span>Name: </span></dt><dd>Value</dd>` pairs. We anchor on
 * the stable `data-section` attribute, then zip the <dt>/<dd> pairs in order.
 */
export async function extractSpecifications(page: Page): Promise<Specification[]> {
    const dl = page.locator('[data-section="SectionProductSpecifications"] dl').first();
    await dl.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
    if ((await dl.count()) === 0) return [];

    const dts = await dl.locator('dt').all();
    const dds = await dl.locator('dd').all();

    const specs: Specification[] = [];
    const count = Math.min(dts.length, dds.length);
    for (let i = 0; i < count; i++) {
        const name = ((await dts[i].textContent()) ?? '').replace(/:\s*$/, '').trim();
        const value = ((await dds[i].textContent()) ?? '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        specs.push({ name, value });
    }

    return specs;
}
