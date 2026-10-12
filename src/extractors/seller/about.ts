import type { Page } from 'playwright';
import type { SellerAbout } from '../../dto/index.js';
import { settleCloudflareChallenge } from '../../utils/cloudflare.js';
import { stripUrlParams } from '../../utils/parse.js';

/** Map a "Basic Information" row label (lower-cased, colon-stripped) to a SellerAbout key. */
const LABEL_TO_KEY: Record<string, keyof SellerAbout> = {
    'company name': 'companyName',
    'business type': 'businessType',
    location: 'location',
    'year established': 'yearEstablished',
    'main product(s)/service': 'mainProducts',
};

/**
 * Navigate to the store's "About Us" tab and extract the Basic Information block
 * plus the store introduction. Returns null when the tab can't be reached or has
 * nothing to offer.
 *
 * The About Us page is a separate server-rendered document linked from the store nav
 * as `a[spm-c="oncabout"]`. Two layouts exist in the wild:
 * - some stores wrap each section in `.aboutcon-warp` with `.store-introduction` /
 *   `.basic-information` classes on the content;
 * - others render flat `.aboutcon` blocks with NO such classes.
 *
 * Both share the stable section-heading ids `#StoreContent` / `#BasicContent`, and in
 * both the content is the adjacent `.aboutcon` sibling of the heading. Anchoring on the
 * ids (not the classes) works for both and avoids a 10s wait on stores that lack the
 * class-based markup. Within the content:
 * - `#StoreContent + .aboutcon dd h2`  -> welcome / introduction text
 * - `#BasicContent + .aboutcon dl`     -> rows of `dt` (label) + `dd` (value)
 *
 * Only fields that carry a value are included — empty rows are omitted rather than
 * emitted as null, so a sparse profile (most stores fill in just a couple of fields)
 * stays compact.
 */
export async function extractSellerAbout(page: Page): Promise<SellerAbout | null> {
    const aboutUrl = await readAboutUrl(page);
    return aboutUrl ? extractSellerAboutAt(page, aboutUrl) : null;
}

/** The About Us link from the store nav, without query / hash; null when the page has none. */
export async function readAboutUrl(page: Page): Promise<string | null> {
    const aboutLink = page.locator('a[spm-c="oncabout"]').first();
    if ((await aboutLink.count()) === 0) return null;
    return stripUrlParams(await aboutLink.getAttribute('href'));
}

/**
 * {@link extractSellerAbout} for a known About Us URL: navigates `page` there. The seller handler
 * passes a second tab, so the About tab loads while the store's own tab goes on to the reviews.
 */
export async function extractSellerAboutAt(page: Page, aboutUrl: string): Promise<SellerAbout | null> {
    // 'commit' (not 'domcontentloaded'): the data is server-rendered in .col-main, but
    // DHGate's body ends with a pile of heavy synchronous inline scripts whose execution
    // delays DOMContentLoaded. Resolve as soon as navigation commits and gate on the
    // #BasicContent heading attaching instead — it parses long before those scripts.
    await page.goto(aboutUrl, { waitUntil: 'commit' }).catch(() => {});
    // This navigation is ours, not Crawlee's, so server.ts's post-navigation hook never sees it:
    // a Cloudflare interstitial on the About tab would otherwise be read as an empty About block.
    await settleCloudflareChallenge(page);
    const basicBlock = page.locator('#BasicContent + .aboutcon').first();
    await page
        .locator('#BasicContent')
        .first()
        .waitFor({ state: 'attached', timeout: 8_000 })
        .catch(() => {});

    const about: SellerAbout = {};

    const introduction = (await readText(page.locator('#StoreContent + .aboutcon dd h2').first())) || null;
    if (introduction) about.introduction = introduction;

    // Basic Information rows: dt is the label ("Company Name:"), dd the value.
    for (const row of await basicBlock.locator('dl').all()) {
        const label = (await readText(row.locator('dt').first())).replace(/:\s*$/, '').toLowerCase();
        const value = await readText(row.locator('dd').first());
        const key = LABEL_TO_KEY[label];
        if (key && value) about[key] = value;
    }

    return Object.keys(about).length > 0 ? about : null;
}

/** Read trimmed text content from a locator, returning '' when the element is absent. */
async function readText(loc: ReturnType<Page['locator']>): Promise<string> {
    if ((await loc.count()) === 0) return '';
    return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}
