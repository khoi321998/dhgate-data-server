import type { Locator, Page } from 'playwright';

/** Pause after each step, so the sections just scrolled into view mount before the next ones do. */
const STEP_PAUSE_MILLIS = 300;

/**
 * Scroll down most of a viewport at a time until `target` is attached, then bring it into view.
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
        await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8))).catch(() => undefined);
        await page.waitForTimeout(STEP_PAUSE_MILLIS).catch(() => undefined);
    }
}
