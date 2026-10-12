import { setTimeout as sleep } from 'node:timers/promises';

import type { Page } from 'playwright';

import { currentJobPrefix, log, runWithJobPrefix } from '../logger.js';
import { blockUnneededRequests } from './blocking.js';

const MAX_CONSOLE_ERRORS_PER_PAGE = 5;

/**
 * Unload a page whose reads are done but that cannot be closed yet — one of Crawlee's pages, which
 * Crawlee closes after the request handler. Its DHGate scripts, video and trackers stop at once
 * instead of running until the rest of the request (another tab) is done.
 */
export async function releasePage(page: Page): Promise<void> {
    await page.goto('about:blank').catch(() => undefined);
}

/**
 * Log the page's uncaught JavaScript errors. DHGate's product page is a Next.js app: an uncaught
 * error replaces the whole page with "Application error: a client-side exception has occurred",
 * after which every extractor waits out its timeout on a DOM that is gone. The error itself only
 * reaches the browser console, so without this the log shows the missing fields but not why.
 */
export function logPageErrors(page: Page, label: string): void {
    // Playwright fires the event outside the request's async context: carry its log prefix over.
    const prefix = currentJobPrefix();
    page.on('pageerror', (error) => {
        const where = (error.stack ?? '')
            .split('\n')
            .slice(1, 3)
            .map((line) => line.trim())
            .join(' ');
        const write = async () =>
            log.warning(`[${label}] page error at ${page.url()}: ${error.message.split('\n')[0]} ${where}`);
        void (prefix ? runWithJobPrefix(prefix, write) : write());
    });
    // A render error React catches — the kind that puts up Next's "Application error" page — never
    // becomes an uncaught `pageerror`; React reports it with console.error. The first few per page are
    // enough to name the cause without logging every failed tracker call.
    let consoleErrors = 0;
    page.on('console', (message) => {
        if (message.type() !== 'error' || consoleErrors >= MAX_CONSOLE_ERRORS_PER_PAGE) return;
        consoleErrors++;
        const write = async () =>
            log.warning(
                `[${label}] console error at ${page.url()}: ${message.text().replace(/\s+/g, ' ').slice(0, 300)}${
                    // "Failed to load resource" does not say which one; the location does.
                    message.location().url ? ` (${message.location().url.slice(0, 200)})` : ''
                }`,
            );
        void (prefix ? runWithJobPrefix(prefix, write) : write());
    });
}

/**
 * Run `fn` in a new tab of `page`'s browser context and close the tab afterwards. Returns `fallback`
 * when `fn` fails or takes longer than `budgetMillis`: the tab is a side trip, and it must not hold
 * the page's request past Crawlee's request handler timeout (a challenge on it alone can be waited
 * on for a minute).
 *
 * The tab shares the context's cookies — Cloudflare clearance, locale and ship-to — and its proxy, so
 * it is the same visitor as `page`. It is not one of Crawlee's pages: it does not count towards
 * MAX_CONCURRENCY and gets no navigation hooks, so `fn` handles Cloudflare on its own navigations
 * (the seller extractors do, with `settleCloudflareChallenge`).
 */
export async function withExtraTab<T>(
    page: Page,
    what: string,
    budgetMillis: number,
    fallback: T,
    fn: (tab: Page) => Promise<T>,
): Promise<T> {
    let tab: Page | undefined;
    const ac = new AbortController();
    const work = (async () => {
        tab = await page.context().newPage();
        logPageErrors(tab, what);
        await blockUnneededRequests(tab);
        return fn(tab);
    })();
    try {
        return await Promise.race([
            work,
            sleep(budgetMillis, undefined, { signal: ac.signal }).then(() => {
                throw new Error(`gave up after ${budgetMillis / 1000}s`);
            }),
        ]);
    } catch (error) {
        log.warning(`[${what}] extra tab failed: ${(error as Error).message.split('\n')[0]}`);
        work.catch(() => undefined);
        return fallback;
    } finally {
        ac.abort();
        // Closing the tab also ends whatever `fn` was still waiting on in it.
        await tab?.close().catch(() => undefined);
    }
}
