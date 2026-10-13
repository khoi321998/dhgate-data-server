import type { Locator, Page } from 'playwright';

/**
 * Half a viewport per step, then a pause long enough for the sections just scrolled into view to
 * fetch their chunk and data before the next ones start. There is no hurry: on `product_and_seller`
 * the product page waits for its store tab anyway, which takes longer.
 */
const STEP_VIEWPORT_RATIO = 0.5;
const STEP_PAUSE_MILLIS = 800;

/** Budget for scrolling down to one lazy block; at {@link STEP_PAUSE_MILLIS} a step, enough for a long page. */
export const SCROLL_TIMEOUT_MILLIS = 25_000;

/**
 * Scroll down half a viewport at a time until `target` is attached, then bring it into view.
 * Returns whether it turned up within `timeoutMillis`.
 *
 * DHGate's product page mounts its lower sections lazily as they come into view. Jumping straight to
 * the bottom mounted all of them at once — description, store block, recommendation strips, footer —
 * each fetching its data through the proxy at the same moment, and that is when the Next.js app was
 * seen crashing into "Application error: a client-side exception has occurred". Stepping down mounts
 * them a few at a time, and stopping at the target never mounts what lies below it.
 */
export async function scrollUntilAttached(page: Page, target: Locator, timeoutMillis: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMillis;
    for (;;) {
        if ((await target.count().catch(() => 0)) > 0) {
            await target
                .first()
                .scrollIntoViewIfNeeded({ timeout: 2_000 })
                .catch(() => undefined);
            return true;
        }
        if (Date.now() >= deadline) return false;
        // At the bottom this is a no-op, and the loop keeps watching while the last sections load.
        await page
            .evaluate((ratio) => window.scrollBy(0, Math.round(window.innerHeight * ratio)), STEP_VIEWPORT_RATIO)
            .catch(() => undefined);
        await page.waitForTimeout(STEP_PAUSE_MILLIS).catch(() => undefined);
    }
}
