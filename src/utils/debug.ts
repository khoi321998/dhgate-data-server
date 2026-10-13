import type { Page } from 'playwright';

/**
 * `DEBUG_PAGE_ERRORS=true`: record what happens on the product page — its JavaScript errors and its
 * failed requests / navigations — and log it when the page crashes into Next's "Application error".
 *
 * Off by default, for diagnosis only. Patchright keeps the page's console closed so Cloudflare and
 * Akamai cannot spot the automation; seeing the errors needs a script injected into the page, which
 * is exactly the kind of trace they look for.
 */
export const DEBUG_PAGE_ERRORS = process.env.DEBUG_PAGE_ERRORS === 'true';

/** The page global the recorder keeps its entries in, named to stay out of the page's way. */
const RECORDER_GLOBAL = '__dhErrs';

/**
 * Runs in the page before its own scripts. Plain JavaScript in a string: no build step touches it, so
 * it cannot pick up helpers (like esbuild's `__name`) that the page does not have.
 */
const ERROR_RECORDER = `(() => {
    if (window.__dhErrs) return;
    var errs = (window.__dhErrs = []);
    var push = function (kind, value) {
        var text;
        try {
            text = value && value.stack ? value.stack : typeof value === 'object' ? JSON.stringify(value) : String(value);
        } catch (e) {
            text = String(value);
        }
        if (errs.length < 50) errs.push(Math.round(performance.now()) + 'ms ' + kind + ': ' + String(text).slice(0, 1500));
    };
    window.addEventListener('error', function (e) {
        if (e.error || e.message) push('uncaught', e.error || e.message);
    });
    window.addEventListener('unhandledrejection', function (e) {
        push('unhandled rejection', e.reason);
    });
    var original = console.error;
    console.error = function () {
        push('console.error', Array.prototype.map.call(arguments, function (a) {
            return a && a.stack ? a.stack : typeof a === 'object' ? (function () { try { return JSON.stringify(a); } catch (e) { return String(a); } })() : String(a);
        }).join(' '));
        return original.apply(console, arguments);
    };
})();`;

interface PageTrace {
    startedAt: number;
    events: string[];
}

const traces = new WeakMap<Page, PageTrace>();

/** Start recording on `page`. Call before its first navigation. */
export async function recordPageErrors(page: Page): Promise<void> {
    const trace: PageTrace = { startedAt: Date.now(), events: [] };
    traces.set(page, trace);
    const note = (text: string) => {
        if (trace.events.length < 80) trace.events.push(`+${Date.now() - trace.startedAt}ms ${text}`);
    };
    // Init scripts run in the page's main world, alongside its own scripts — where its errors are.
    await (page as unknown as { addInitScript: (script: string) => Promise<void> }).addInitScript(ERROR_RECORDER);
    page.on('requestfailed', (request) => {
        const reason = request.failure()?.errorText ?? '?';
        // Our own blocking (see utils/blocking.ts) is not news.
        if (reason === 'net::ERR_BLOCKED_BY_CLIENT' || reason === 'inspector') return;
        note(`request failed ${reason} [${request.resourceType()}] ${request.url().slice(0, 200)}`);
    });
    page.on('response', (response) => {
        const url = response.url();
        if (response.status() >= 400 && /dhgate\.com|dhresource\.com/.test(url)) {
            note(`HTTP ${response.status()} [${response.request().resourceType()}] ${url.slice(0, 200)}`);
        }
    });
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) note(`url -> ${frame.url().slice(0, 200)}`);
    });
}

/** What was recorded on `page`: network / navigation events, then the page's JavaScript errors. */
export async function readPageErrors(page: Page): Promise<string[]> {
    const network = traces.get(page)?.events ?? [];
    const errors = await (
        page as unknown as {
            evaluate: (
                fn: (arg: unknown) => unknown,
                arg: unknown,
                options: object,
                isolatedContext: boolean,
            ) => Promise<unknown>;
        }
    )
        // Patchright's 4th argument: `false` reads the main world, where the recorder runs.
        .evaluate(
            (name) =>
                (window as unknown as Record<string, string[] | undefined>)[name as string] ?? [
                    '(recorder not installed)',
                ],
            RECORDER_GLOBAL,
            {},
            false,
        )
        .catch((error: Error) => [`(could not read the page's errors: ${error.message.split('\n')[0]})`]);
    return [...network.map((e) => `network ${e}`), ...(errors as string[]).map((e) => `js ${e}`)];
}
