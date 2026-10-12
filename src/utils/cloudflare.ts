import { setTimeout as sleep } from 'node:timers/promises';

import type { PlaywrightCrawlingContext, Request } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import type { Page } from 'playwright';

/**
 * DHGate sits behind a Cloudflare challenge ("Just a moment…"), in two flavours.
 *
 * It is not an IP ban: the same IP answers 200 to curl with a plain Chrome User-Agent, and to a
 * real Google Chrome. What trips it is the browser fingerprint — an automated browser gets
 * challenged, and then has to prove itself by running Cloudflare's JS for a few seconds.
 *
 * Two consequences for the crawler:
 *
 * 1. The interstitial is served with **HTTP 403**, which is exactly what `detectBlocked` treats as
 *    a refusal. We used to throw on it immediately — three retries, three challenges, `FETCH_FAILED`
 *    — while the challenge sitting in that very tab would have cleared itself a second later.
 * 2. Once cleared, Cloudflare navigates the tab to the real page on its own. Crawlee never sees
 *    that second navigation, so `ctx.response` keeps reporting the challenge's 403 for a document
 *    that is, by then, the product page.
 *
 * So {@link passCloudflare} runs the whole gate as one post-navigation step, in three moves:
 *
 * - wait the non-interactive variant out ({@link settleCloudflareChallenge}),
 * - if waiting is not enough, tick the "Verify you are human" checkbox (Crawlee's
 *   `handleCloudflareChallenge`, which clicks it with a real mouse event — the widget lives in a
 *   cross-origin iframe, so a click at the right coordinates is the only way in),
 * - and stop trusting the recorded status once we are through ({@link effectiveStatus}).
 *
 * Two things outside this file do most of the work of *not* being challenged in the first place:
 * `server.ts` launches the real Google Chrome rather than the bundled Chromium (see utils/browser.ts
 * for why that matters more than anything in here), and it runs headed — headless never cleared the
 * challenge in testing, no matter how long it was given.
 */

/**
 * Read a timeout from the environment, falling back to `fallback` for unset or unparseable values.
 * Both budgets below are exposed this way because the right number depends on how fast the machine
 * is, and on Apify that can be changed from the Console without rebuilding the Actor.
 */
function millisFromEnv(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long to let Cloudflare's JS work before calling it stuck.
 *
 * It clears in ~5s on a developer machine — but this code's real home is a shared-CPU Apify
 * container, and the challenge is a CPU-bound JS workload. Measured against DHGate with the CPU
 * throttled, page work scales close to linearly: 4x throttle ≈ 4x the wall clock, 8x ≈ 10x. So a
 * budget that looks generous locally is not, and the asymmetry favours patience: waiting too long
 * costs seconds on a request that was failing anyway, while cutting a challenge off one second
 * early throws away an attempt that was about to succeed.
 */
const CHALLENGE_TIMEOUT_MILLIS = millisFromEnv('DHGATE_CHALLENGE_TIMEOUT_MS', 60_000);

/**
 * Budget for the *interactive* variant — the one with a "Verify you are human" checkbox.
 *
 * Deliberately much shorter, because waiting is not what solves this one: clicking is. This is only
 * the grace period we give Cloudflare to auto-solve its own widget (which it does, sometimes)
 * before {@link passCloudflare} stops waiting and goes for the checkbox. Every second spent here is
 * a second that click is delayed, so it is sized to "a slow container might just be slow", no more.
 */
const INTERACTIVE_TIMEOUT_MILLIS = millisFromEnv('DHGATE_INTERACTIVE_CHALLENGE_TIMEOUT_MS', 6_000);

/**
 * Budget for `managed` — Cloudflare's modern default, where it decides at run time whether to let
 * the browser through, show a spinner, or render a widget.
 *
 * Measured on Apify, not guessed: a managed challenge that is going to reject us does not clear
 * slowly, it never clears. The first platform run sat on one for the full 60s of
 * {@link CHALLENGE_TIMEOUT_MILLIS} and then still needed the checkbox — 60 wasted seconds on every
 * one of the request's four attempts. Since a managed challenge that *accepts* the browser clears in
 * seconds, a long budget buys nothing here and costs minutes, so this one is short and gets to the
 * click quickly.
 */
const MANAGED_TIMEOUT_MILLIS = millisFromEnv('DHGATE_MANAGED_CHALLENGE_TIMEOUT_MS', 15_000);

/** How many challenge snapshots one run may write, so a bad run cannot fill the key-value store. */
const MAX_SNAPSHOTS = Math.max(0, Number(process.env.DHGATE_MAX_CHALLENGE_SNAPSHOTS ?? 5) || 0);

/**
 * How many times we are willing to actually click the checkbox before accepting the answer is no.
 *
 * Crawlee's helper loops a hard-coded ten times, which at the human pace of {@link clickLikeAHuman}
 * is about 55 seconds — and ten attempts of that overran the Actor's 300s timeout, killing the run
 * before it could report anything. Five is the middle ground: each extra click is jittered
 * differently and lands on a freshly measured widget, so it is not quite the same test twice, but
 * the cost is real — roughly five seconds per click, on every one of the request's attempts. The
 * remaining loop iterations still run — they are what notices the challenge clearing — they just
 * stop clicking.
 */
const MAX_CLICKS = Math.max(1, Number(process.env.DHGATE_MAX_CHALLENGE_CLICKS ?? 5) || 5);

/** How often to re-check whether the interstitial is gone. */
const POLL_INTERVAL_MILLIS = 500;

/** Titles Cloudflare's interstitials carry, across the managed/JS/legacy variants. */
export const CHALLENGE_TITLE = /just a moment|checking your browser|verifying you are human|attention required/i;

/** What {@link settleCloudflareChallenge} found. `none` is the happy path: no challenge at all. */
export type ChallengeOutcome = 'none' | 'passed' | 'stuck';

/**
 * Is the document currently on screen a Cloudflare interstitial?
 *
 * The title is the reliable signal; `_cf_chl_opt` (the challenge's config object) and the
 * `#challenge-error-text` node back it up for localized titles. A rejected `evaluate` means the
 * page navigated out from under us — which, mid-challenge, is the challenge passing.
 *
 * The pattern is handed in as a string because a `RegExp` does not survive the trip into the page.
 */
async function isChallengePage(page: Page): Promise<boolean> {
    return page
        .evaluate((titlePattern) => {
            if (new RegExp(titlePattern, 'i').test(document.title)) return true;
            return document.getElementById('challenge-error-text') != null || '_cf_chl_opt' in window;
        }, CHALLENGE_TITLE.source)
        .catch(() => false);
}

/**
 * Which flavour of challenge is on screen, straight from Cloudflare's own config object:
 * `non-interactive` clears itself, `interactive` wants a checkbox ticked. `null` when the page
 * is not a challenge, or is one we cannot read the type off.
 */
async function readChallengeType(page: Page): Promise<string | null> {
    return page
        .evaluate(() => {
            // eslint-disable-next-line no-underscore-dangle -- Cloudflare's name for it, not ours.
            const opt = (window as unknown as { _cf_chl_opt?: { cType?: string } })._cf_chl_opt;
            return opt?.cType ?? null;
        })
        .catch(() => null);
}

/**
 * Is there a checkbox on screen right now — a laid-out Turnstile widget, not a hidden one?
 *
 * This is the signal that actually decides how long waiting is worth, and it is checked because
 * `_cf_chl_opt.cType` cannot be relied on: on the platform it reads `null` (the config object is
 * not exposed on every variant), and a `null` type used to buy the full non-interactive minute
 * even with the checkbox already rendered — 60s of waiting, then one click that cleared it.
 *
 * Presence of the hidden input is not enough: the managed/invisible variants embed Turnstile too
 * and solve themselves. Only a widget with a real box is something a click can land on, which is
 * why this measures rather than just querying — the same rule {@link turnstileClickPosition} aims by.
 */
async function turnstileCheckboxVisible(page: Page): Promise<boolean> {
    return page
        .evaluate(() => {
            const token = document.querySelector('input[name="cf-turnstile-response"]');
            const host = token?.parentElement?.querySelector(':scope > div');
            const r = host?.getBoundingClientRect();
            return r != null && r.width > 0 && r.height > 0;
        })
        .catch(() => false);
}

/** What a challenge cost us, so the budgets above can be tuned from evidence rather than guesswork. */
export interface ChallengeResult {
    outcome: ChallengeOutcome;
    /** Cloudflare's own label for the variant (`non-interactive`, `interactive`, …), when readable. */
    type: string | null;
    /** Wall clock spent waiting. Zero when there was no challenge. */
    elapsedMillis: number;
    /** What it was allowed to spend — the number to raise if `stuck` keeps landing near it. */
    budgetMillis: number;
}

/**
 * How long this challenge is worth waiting on.
 *
 * A visible checkbox settles it regardless of what Cloudflare calls the variant: waiting does not
 * solve that page, clicking does, and every second spent here delays the click. It is checked first
 * precisely because the type is the less trustworthy of the two — it reads `null` on the platform.
 *
 * Without a checkbox, waiting is the *only* move — there is nothing for {@link passCloudflare} to
 * click — so an unlabelled challenge keeps the long budget.
 */
function budgetFor(type: string | null, checkboxVisible: boolean): number {
    if (checkboxVisible || type === 'interactive') return INTERACTIVE_TIMEOUT_MILLIS;
    if (type === 'managed') return MANAGED_TIMEOUT_MILLIS;
    return CHALLENGE_TIMEOUT_MILLIS;
}

/**
 * Sit on the Cloudflare interstitial until it clears itself.
 *
 * Polls rather than using `waitForFunction`, because clearing the challenge is a real navigation:
 * an injected predicate loses its execution context halfway through and throws instead of
 * resolving. Returns immediately when there is no challenge, so it is cheap on the happy path.
 */
export async function settleCloudflareChallenge(page: Page): Promise<ChallengeResult> {
    if (!(await isChallengePage(page))) {
        return { outcome: 'none', type: null, elapsedMillis: 0, budgetMillis: 0 };
    }

    let type = await readChallengeType(page);
    let checkbox = await turnstileCheckboxVisible(page);
    let budgetMillis = budgetFor(type, checkbox);

    const startedAt = Date.now();
    // The budget is re-read every iteration rather than frozen into a deadline, because the branch
    // below can shrink it partway through.
    while (Date.now() - startedAt < budgetMillis) {
        await sleep(POLL_INTERVAL_MILLIS);

        if (await isChallengePage(page)) {
            // Two things can change under us, and both shorten the wait. Cloudflare can escalate a
            // non-interactive challenge into the checkbox one; and the checkbox itself is mounted a
            // moment *after* the page loads, so a challenge that looked unlabelled and click-less on
            // the first reading grows a widget a second later. Re-read both and cut the budget the
            // moment either says "this one needs a click" — otherwise a request that needs one click
            // burns the full minute first, which is exactly what the platform runs were doing.
            const currentType = await readChallengeType(page);
            const currentCheckbox = await turnstileCheckboxVisible(page);
            if ((currentType && currentType !== type) || currentCheckbox !== checkbox) {
                const next = budgetFor(currentType ?? type, currentCheckbox);
                if (next !== budgetMillis) {
                    log.info(
                        `Cloudflare challenge changed: type ${type ?? 'unknown'} -> ${currentType ?? 'unknown'}, ` +
                            `checkbox ${checkbox} -> ${currentCheckbox}; wait budget now ${next}ms`,
                    );
                    budgetMillis = next;
                }
                type = currentType ?? type;
                checkbox = currentCheckbox;
            }
            continue;
        }

        // Not a challenge *right now* — but that is not the same as being through. Two ways this
        // reading lies, both seen against DHGate: the check can land in the gap between documents
        // (the `evaluate` rejects, which we read as "no challenge"), and Cloudflare can hand the
        // challenge straight to *another* challenge. So let the next document parse, then look
        // again; only a page that is still clean after settling counts as passed, and anything
        // else drops back into the loop with the remaining budget.
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await sleep(POLL_INTERVAL_MILLIS);
        if (!(await isChallengePage(page))) {
            return { outcome: 'passed', type, elapsedMillis: Date.now() - startedAt, budgetMillis };
        }
    }
    return { outcome: 'stuck', type, elapsedMillis: Date.now() - startedAt, budgetMillis };
}

/**
 * Where the "Verify you are human" checkbox actually is.
 *
 * Crawlee's helper aims at `.main-content div` with a fixed `+30, +25` offset, and on DHGate's
 * interstitial that is simply the wrong element. The page reads:
 *
 * ```html
 * <div class="main-content">
 *   <div class="lpdkQ3"><img …><h1>www.dhgate.com</h1></div>   ← first div: the site header
 *   <h2>Performing security verification</h2>
 *   <div id="lVJB5"><div><div>
 *     <div></div>                                              ← the widget
 *     <input type="hidden" name="cf-turnstile-response">
 * ```
 *
 * `.main-content div` matches the header, so the clicks landed at (222, 153) — on the heading text,
 * about 185px above a checkbox sitting at (213, 337). Ten clicks into empty space, which is exactly
 * what the platform run showed.
 *
 * Looking for the widget's `<iframe>` does not help either: Turnstile mounts it inside a **closed
 * shadow root** on that empty `<div>`, so `querySelectorAll('iframe')` returns nothing and
 * `page.content()` serializes nothing — which is why the saved HTML has no iframe in it at all
 * while the screenshot plainly shows the widget.
 *
 * What *is* reachable is the hidden input Turnstile writes its token into. `cf-turnstile-response`
 * is Cloudflare's own API contract — the name a site reads the token back from — so unlike the
 * hashed `lpdkQ3` class names around it, it is stable. Measure from there.
 *
 * Returning `undefined` leaves Crawlee's guess in place, which is the honest fallback: on a page
 * with no widget there is nothing better to aim at.
 */
async function turnstileClickPosition(page: Page): Promise<{ x: number; y: number } | undefined> {
    const box = await page
        .evaluate(() => {
            // Zero-sized means mounted but not laid out — or one of the `display: none` stages the
            // challenge page keeps in reserve. Aiming at either would miss.
            const measure = (el: Element | null | undefined) => {
                const r = el?.getBoundingClientRect();
                return r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, height: r.height } : null;
            };

            const token = document.querySelector('input[name="cf-turnstile-response"]');
            if (token) {
                // The widget is the sibling <div> the shadow root hangs off; its parent is the
                // fallback, since it wraps the widget and the hidden input and little else.
                const host = token.parentElement?.querySelector(':scope > div');
                const found = measure(host) ?? measure(token.parentElement);
                if (found) return found;
            }

            // Layouts that embed Turnstile the ordinary way leave a visible iframe to measure.
            const frame = [...document.querySelectorAll('iframe')].find((f) =>
                /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\//.test(f.src),
            );
            return measure(frame);
        })
        .catch(() => null);

    // Turnstile draws the checkbox at the left of the widget, vertically centred: ~22px in from the
    // left edge, half the height down. Measured off the saved screenshot, not guessed.
    return box ? { x: box.x + 22, y: box.y + box.height / 2 } : undefined;
}

/** A number in `[min, max)`, for the small human variations below. */
function jitter(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

/**
 * Click the checkbox the way a person would.
 *
 * Crawlee's built-in click is `page.mouse.click(x, y)` — the pointer teleports to the target and
 * fires, with no movement before it — repeated twice per round for ten rounds. Both halves of that
 * are a problem, and neither is about coordinates: Turnstile grades the pointer's *history* leading
 * into the click, so an instant jump reads as automation, and twenty clicks in ten seconds on the
 * same spot reads as hammering. This was measured, not guessed — a hand-driven click on the very
 * same page passes.
 *
 * So: approach from somewhere else, travel in steps, pause on the target before pressing, hold the
 * button for a human moment, then give Turnstile time to verify before anyone clicks again. The
 * numbers are jittered because a *constant* delay is its own fingerprint.
 */
async function clickLikeAHuman(page: Page, x: number, y: number): Promise<void> {
    // Start off-target and to one side, the way a pointer arrives from elsewhere on the page.
    await page.mouse.move(x - jitter(90, 220), y + jitter(40, 130));
    await sleep(jitter(120, 300));

    // `steps` is what turns one jump into a path of intermediate mousemove events.
    await page.mouse.move(x, y, { steps: Math.round(jitter(16, 30)) });
    // A real pointer settles on the target before the button goes down.
    await sleep(jitter(180, 420));

    await page.mouse.down();
    await sleep(jitter(60, 140)); // press duration, not a pause between clicks
    await page.mouse.up();

    // Turnstile needs a couple of seconds to verify. Clicking again during that window is both
    // pointless and the exact behaviour its bot heuristics are looking for.
    await sleep(jitter(2_800, 4_200));
}

/**
 * What the challenge page is actually made of, read straight from its DOM.
 *
 * Worth its own function because the log alone cannot tell two very different failures apart: a
 * widget we aimed at and missed, and a page with no widget on it at all. `widget` and `crawleeAnchor`
 * side by side say which — the first platform run had them 185px apart, which is how the bad click
 * position was found. `hasToken` distinguishes "no widget here" from "widget we failed to measure".
 */
async function describeChallengePage(page: Page) {
    return page
        .evaluate(() => {
            const box = (el: Element | null | undefined) => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            };
            const token = document.querySelector('input[name="cf-turnstile-response"]');
            return {
                title: document.title,
                // Turnstile declines to verify a page it believes nobody is looking at. Under Xvfb
                // there is no real display, and a page Crawlee opened alongside others can sit in a
                // background tab, so both of these are worth seeing next to a failed click.
                visibility: document.visibilityState,
                focused: document.hasFocus(),
                // Whether Turnstile is on the page at all, even when its box cannot be measured.
                hasToken: token != null,
                // The widget itself — the shadow host the checkbox is rendered inside.
                widget: box(token?.parentElement?.querySelector(':scope > div')) ?? box(token?.parentElement),
                // What Crawlee's `handleCloudflareChallenge` would aim at if left to itself.
                crawleeAnchor: box(document.querySelector('.main-content div')),
                text: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '',
            };
        })
        .catch(() => null);
}

/** A point the crawler aimed a click at, so the logs and the saved measurements can say where. */
export interface ClickPoint {
    x: number;
    y: number;
}

/** Counts against {@link MAX_SNAPSHOTS}. Module state on purpose: the cap is per run, not per request. */
let snapshotsTaken = 0;

/**
 * Put the challenge page in the key-value store: the HTML and the measurements.
 *
 * No screenshot is taken — not here and not around the clicks. What is left has to carry the
 * diagnosis on its own, and mostly can: the HTML shows the structure but **not the widget**
 * (Turnstile lives in a closed shadow root, which `page.content()` does not serialize, so the saved
 * markup has no `<iframe>` in it at all), which is why the measurements from
 * {@link describeChallengePage} go in as their own JSON record — `widget` next to `crawleeAnchor`
 * and the click points is what a picture of the page would otherwise have had to show.
 */
async function snapshotChallenge(
    page: Page,
    request: Request,
    details: unknown,
    clicks: ClickPoint[],
): Promise<string | null> {
    if (snapshotsTaken >= MAX_SNAPSHOTS) return null;
    snapshotsTaken++;

    const key = `challenge-${request.id ?? 'unknown'}-${request.retryCount}`;
    try {
        await Actor.setValue(`${key}-meta`, {
            url: request.url,
            loadedUrl: page.url(),
            retryCount: request.retryCount,
            at: new Date().toISOString(),
            clicks,
            // Where a correct click would have to land, next to where we actually sent one.
            details,
            note:
                'The HTML record omits the Turnstile widget: it renders inside a closed shadow root, ' +
                'which page.content() cannot serialize. Read `details.widget` for where it was.',
        });
        await Actor.setValue(`${key}-html`, await page.content(), { contentType: 'text/html; charset=utf-8' });
        return key;
    } catch (error) {
        // Diagnostics must never be the thing that fails a run.
        log.warning(`Could not snapshot the Cloudflare challenge: ${(error as Error).message}`);
        return null;
    }
}

/**
 * Everything we know about a challenge we could not get past: one log line, plus the raw HTML and
 * the measurements as JSON.
 *
 * The title and URL tell a challenge loop apart from a hard block page; `widget` next to
 * `crawleeAnchor` and the click points tell a missed click apart from a page that never had a
 * checkbox. Between them they decide whether the next move is "fix the click position" or "this
 * browser is being fingerprinted, change the browser" — very different amounts of work.
 */
async function reportStuckChallenge(
    page: Page,
    request: Request,
    what: string,
    clicks: ClickPoint[] = [],
): Promise<void> {
    const details = await describeChallengePage(page);

    // Printed as flat text rather than left to the structured second argument, because the whole
    // point is to read the verdict off the Apify console without opening the key-value store —
    // and because a run that dies on its timeout leaves nothing in that store to open.
    const geometry = (b: { x: number; y: number; w: number; h: number } | null | undefined) =>
        b ? `${b.x},${b.y} ${b.w}x${b.h}` : 'not found';
    const summary = details
        ? [
              `title="${details.title}"`,
              `visibility=${details.visibility}`,
              `focused=${details.focused}`,
              `turnstilePresent=${details.hasToken}`,
              `widget=[${geometry(details.widget)}]`,
              `crawleeAnchor=[${geometry(details.crawleeAnchor)}]`,
              `clicked=[${clicks.map((c) => `${Math.round(c.x)},${Math.round(c.y)}`).join(' ') || 'nothing'}]`,
          ].join(' ')
        : '(page unreadable)';

    const key = await snapshotChallenge(page, request, details, clicks);
    log.warning(`Cloudflare: ${what}`);
    log.warning(`  at ${page.url()}`);
    log.warning(`  ${summary}`);
    log.warning(`  on screen: ${details?.text?.slice(0, 160) ?? '(unreadable)'}`);
    if (key) log.warning(`  saved: "${key}-html", "${key}-meta"`);
}

/**
 * The whole Cloudflare gate, as one post-navigation step.
 *
 * Waiting clears the non-interactive variant. What it never clears is the one with the "Verify you
 * are human" checkbox — for that, Crawlee's `handleCloudflareChallenge` aims a real
 * `page.mouse.click` (with a randomized offset) at where the widget renders, because the checkbox
 * lives in a cross-origin iframe that no selector of ours can reach into.
 *
 * That helper throws a `SessionError` when it finds the hard "Sorry, you have been blocked" page or
 * when the challenge survives its clicks. We deliberately let that propagate, because Crawlee
 * answers a `SessionError` by retiring the session before reclaiming the request — which is what
 * buys the retry a new IP and a new browser. Note that it *does* still cost one of the request's
 * three retries (`_requestFunctionErrorHandler` increments `retryCount` for every retryable error,
 * `SessionError` included); `maxSessionRotations` is a second, higher ceiling of 10, not a way
 * around `maxRequestRetries`.
 */
export async function passCloudflare(ctx: PlaywrightCrawlingContext): Promise<void> {
    const { page, request, session, handleCloudflareChallenge } = ctx;

    const waited = await settleCloudflareChallenge(page);
    if (waited.outcome !== 'stuck') {
        recordChallengeOutcome(request, waited.outcome);
        if (waited.outcome === 'passed') {
            // Logged with its timing on purpose: this is the only way to find out what the
            // challenge actually costs on Apify's shared CPU, which is where the budgets above are
            // guesses. An `elapsedMillis` creeping towards `budgetMillis` in production is the
            // signal to raise DHGATE_CHALLENGE_TIMEOUT_MS.
            log.info(
                `Cleared Cloudflare challenge (${waited.type ?? 'unknown'}) by waiting ` +
                    `${waited.elapsedMillis}ms of ${waited.budgetMillis}ms for ${request.url}`,
            );
        }
        return;
    }

    // `elapsedMillis`, not `budgetMillis`: an escalated challenge shrinks its own budget mid-wait,
    // so only the elapsed figure describes what this request actually cost.
    log.info(
        `Cloudflare challenge (${waited.type ?? 'unknown'}) still up after ${waited.elapsedMillis}ms ` +
            `for ${request.url} — going for the checkbox`,
    );
    // Turnstile will not verify a page it thinks is in the background, and Crawlee opens pages
    // side by side in one browser — the loser of that race reports `visibilityState: 'hidden'`.
    // Cheap insurance before aiming a click; harmless when the page was in front already.
    await page.bringToFront().catch(() => undefined);
    // Providing `clickCallback` takes the clicking away from the helper entirely — see
    // `clickLikeAHuman` for why its own is the thing that was failing. Crawlee only logs the click
    // it performs itself, so with ours in place this list is the sole record that a click happened
    // at all, which is exactly the "did it actually click, and where?" question the logs could not
    // answer before. It is also what gets drawn on the failure screenshot.
    const clickPoints: ClickPoint[] = [];
    try {
        await handleCloudflareChallenge({
            verbose: true,
            // Crawlee's own challenge detector keys off one specific footer node (`.ray-id`); ours
            // reads the title and Cloudflare's `_cf_chl_opt`, which also survives localized
            // interstitials. Hand ours in so the helper and the re-check below agree on what "still
            // challenged" means.
            isChallengeCallback: isChallengePage,
            // The cast is safe and deliberate: the option is typed as always returning a point, but
            // the helper guards it (`const pos = await clickPositionCallback(page); if (pos) …`), so
            // `undefined` means "keep your own guess" rather than crashing. That is exactly the
            // fallback we want when no widget is on the page to measure.
            clickPositionCallback: turnstileClickPosition as (page: Page) => Promise<{ x: number; y: number }>,
            clickCallback: async (clickPage, { x, y }) => {
                // Past the cap this becomes a no-op so the helper's remaining rounds cost a second
                // each instead of five — the loop keeps watching for the challenge to clear, which
                // is the only thing those later rounds were ever contributing.
                if (clickPoints.length >= MAX_CLICKS) return;
                clickPoints.push({ x, y });
                log.info(
                    `Clicking the Cloudflare checkbox (try ${clickPoints.length}/${MAX_CLICKS}) at ` +
                        `${Math.round(x)},${Math.round(y)}`,
                );
                // `clickPage` rather than the outer `page` — the helper hands in the page it is
                // actually driving.
                await clickLikeAHuman(clickPage, x, y);
            },
            // `clickLikeAHuman` already spends ~3-4s letting Turnstile verify, so the helper's own
            // pause between rounds is cut to keep a round near five seconds rather than eight.
            preChallengeSleepSecs: 1,
            // Trimmed from the default 10 for the same timeout reason: the last click has already
            // been followed by its own few seconds of settling, so this is a margin, not the wait.
            sleepSecs: 6,
        });
    } catch (error) {
        // The helper throws `SessionError` once its clicks are spent. That is the right outcome and
        // it goes on to the caller untouched — but it is also the last moment the challenge page
        // still exists, so the evidence has to be collected here or not at all.
        await reportStuckChallenge(
            page,
            request,
            `${clickPoints.length} click(s) did not clear the (${waited.type ?? 'unknown'}) challenge`,
            clickPoints,
        );
        recordChallengeOutcome(request, 'stuck');
        throw error;
    }

    // The helper returns quietly — no click, no error — when it cannot find the element it aims at,
    // so confirm rather than assume.
    const clicked = await settleCloudflareChallenge(page);
    if (clicked.outcome === 'stuck') {
        // An empty `clickPoints` here is its own diagnosis: the helper never found a widget to aim
        // at, so nothing was ever clicked and the coordinates are not what needs fixing.
        await reportStuckChallenge(
            page,
            request,
            clickPoints.length === 0
                ? `no widget to click — the (${clicked.type ?? 'unknown'}) challenge is still up, retiring session`
                : `the (${clicked.type ?? 'unknown'}) challenge outlived ${clickPoints.length} click(s), retiring`,
            clickPoints,
        );
        recordChallengeOutcome(request, 'stuck');
        session?.retire();
        return;
    }

    // A clean page here means the click worked. That is `passed`, not `none`, even though there is
    // no challenge left to see: the status Crawlee recorded still belongs to the 403 interstitial,
    // not to the document now on screen, and `effectiveStatus` has to know to ignore it.
    recordChallengeOutcome(request, 'passed');
    log.info(
        `Cleared Cloudflare challenge (${waited.type ?? 'unknown'}) after ${clickPoints.length} click(s) ` +
            `for ${request.url}`,
    );
}

/** Key under which the pre/post-navigation hooks record the outcome for the handlers. */
const PASSED_FLAG = 'cloudflarePassed';

/** Record that this navigation ended up past a challenge (or did not). Written on every attempt. */
export function recordChallengeOutcome(request: Request, outcome: ChallengeOutcome): void {
    (request.userData as Record<string, unknown>)[PASSED_FLAG] = outcome === 'passed';
}

/**
 * The HTTP status that actually describes the document the handlers are about to read.
 *
 * When a challenge was passed, the recorded status belongs to the interstitial (403), not to the
 * page now on screen — and we never saw the status of that one. `undefined` says exactly that:
 * both `detectBlocked` and `detectNotFound` treat a missing status as "unknown, judge by the DOM",
 * which is the only honest thing to do here.
 */
export function effectiveStatus(request: Request, navigationStatus?: number): number | undefined {
    const passed = (request.userData as Record<string, unknown>)[PASSED_FLAG] === true;
    return passed ? undefined : navigationStatus;
}
