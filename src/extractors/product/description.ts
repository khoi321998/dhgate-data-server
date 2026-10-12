import type { Page } from 'playwright';
import type { Description } from '../../dto/index.js';

/**
 * Extract the product description as both raw HTML and plain text.
 *
 * The description is a rich seller-authored HTML blob (`<p>`/`<img>`/inline styles)
 * with hashed React class names, so we anchor on the stable `spm-c` collapse toggle
 * that sits next to it (`seeall_discription` when collapsed, `seeless_discription`
 * when expanded). The description content is the toggle's sibling block:
 *
 *   <div class="NRnqd7k">
 *     <div class="DrwOlGe …"> …description HTML… </div>   <- content
 *     <span spm-c="seeless_discription">View less</span>  <- toggle (anchor)
 *   </div>
 *
 * Returns empty strings when the block can't be found.
 */
export async function extractDescription(page: Page): Promise<Description> {
    const empty: Description = { html: '', plainText: '' };

    // The description mounts lazily low on the page — scroll down so React renders it.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    const toggle = page.locator('[spm-c="seeall_discription"], [spm-c="seeless_discription"]').first();
    await toggle.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    if ((await toggle.count()) === 0) return empty;

    const result = await page.evaluate(() => {
        const tog = document.querySelector('[spm-c="seeall_discription"], [spm-c="seeless_discription"]');
        const container = tog?.parentElement;
        if (!container) return null;
        // Content is the block sibling of the toggle (the toggle itself is a <span>).
        const content = Array.from(container.children).find((el) => el !== tog && el.tagName === 'DIV');
        if (!content) return null;
        const plainText = (content as HTMLElement).innerText
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .join('\n');
        return { html: content.innerHTML.trim(), plainText };
    });

    return result ?? empty;
}
