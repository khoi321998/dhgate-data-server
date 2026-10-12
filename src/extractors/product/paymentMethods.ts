import { log } from 'apify';
import type { Frame, Page } from 'playwright';

const LOGO_SELECTOR = '.j-paymentListImg .paymentitem img';
const CLICK_TIMEOUT_MS = 5_000;
const WAIT_TIMEOUT_MS = 10_000;
// `locator.count()` takes no timeout of its own and stalls on a frame that has no execution context
// yet (an ad/tracker iframe mid-navigation). On a CPU-starved container that stall was what pushed
// this step to ~31s against a nominal 15s, so every probe gets its own short ceiling.
const FRAME_PROBE_TIMEOUT_MS = 1_000;

/** Resolves to `fallback` if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    try {
        return await Promise.race([promise.catch(() => fallback), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The payment logo list is rendered by a separately-fetched "Buyer Protection"
 * mini-page (own <title>/<meta>, m.dhgate.com-authored) that DHGate embeds into
 * the modal — it may land in the main document or an iframe depending on build,
 * so poll every frame rather than assuming one.
 *
 * The deadline is checked before every frame probe, not once per sweep: a sweep
 * over DHGate's many iframes can itself take seconds, and checking only at the
 * end let the last sweep run far past the budget.
 */
async function waitForPaymentFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs;
    const mainFrame = page.mainFrame();
    while (Date.now() < deadline) {
        // Main document first: it is the cheapest probe and the most common home of the list.
        const frames = [mainFrame, ...page.frames().filter((f) => f !== mainFrame)];
        for (const frame of frames) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            if (frame.isDetached()) continue;
            const count = await withTimeout(
                frame.locator(LOGO_SELECTOR).count(),
                Math.min(FRAME_PROBE_TIMEOUT_MS, remaining),
                0,
            );
            if (count > 0) return frame;
        }
        await page.waitForTimeout(250);
    }
    return null;
}

/**
 * Extract the accepted payment methods (as logo image URLs) from the
 * "Buyer Protection" modal.
 *
 * The list is NOT present in the initial DOM: clicking the trigger
 * (`[spm-c="buyPtc"]`) opens the modal, whose content itself fires an XHR
 * (`getPaymentMethodIcons.do`) and replaces `.j-paymentListImg` with `<img>`
 * logos localized to the buyer's shipping country. We wait for that
 * replacement, then read each logo's `src` — filenames aren't a reliable
 * naming scheme (e.g. "klarna2024", "Google_Pay"), so the URL is kept as-is.
 */
export async function extractPaymentMethods(page: Page): Promise<string[]> {
    const startedAt = Date.now();
    const trigger = page.locator('[spm-c="buyPtc"]').first();
    if ((await trigger.count()) === 0) {
        log.debug('[paymentMethods] no Buyer Protection trigger on the page');
        return [];
    }

    // The click failing used to be swallowed silently, leaving "(none)" indistinguishable from a
    // modal that opened but never received its logos. Keep the reason so the log can tell them apart.
    let clickError: string | null = null;
    await trigger.click({ timeout: CLICK_TIMEOUT_MS }).catch((error: Error) => {
        clickError = error.message.split('\n')[0];
    });
    const clickMillis = Date.now() - startedAt;

    const frame = await waitForPaymentFrame(page, WAIT_TIMEOUT_MS);
    const waitMillis = Date.now() - startedAt - clickMillis;
    await page.keyboard.press('Escape').catch(() => {});

    const timing = { clickMillis, waitMillis, frames: page.frames().length };
    if (!frame) {
        log.warning(
            `[paymentMethods] no payment logos found — ${clickError ? `click failed: ${clickError}` : 'clicked, but the list never rendered'}`,
            timing,
        );
        return [];
    }

    const urls: string[] = [];
    const seen = new Set<string>();
    for (const el of await frame.locator(LOGO_SELECTOR).all()) {
        const src = await el.getAttribute('src');
        if (!src || seen.has(src)) continue;
        seen.add(src);
        urls.push(src);
    }

    const totalMillis = Date.now() - startedAt;
    // Only surface timings when the step was slow — that is the case worth diagnosing.
    const report = totalMillis > 5_000 ? log.info.bind(log) : log.debug.bind(log);
    report('[paymentMethods] done', { ...timing, totalMillis, logos: urls.length });
    return urls;
}
