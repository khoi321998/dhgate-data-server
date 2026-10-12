import { existsSync } from 'node:fs';
import { platform } from 'node:os';

/**
 * Which Chrome the crawler drives — the single biggest lever this Actor has on Cloudflare.
 *
 * DHGate's challenge is a *fingerprint* trigger, not an IP ban (see utils/cloudflare.ts): the same
 * IP that gets challenged in Playwright's bundled Chromium answers HTTP 200 to a real Google
 * Chrome. That is not luck. Chromium and Chrome are different builds, and they differ in exactly
 * the places a bot check looks — the open-source build ships no proprietary media codecs (no
 * H.264/AAC in `canPlayType`), brands itself "Chromium" in `navigator.userAgentData.brands`, has no
 * Widevine CDM and no PDF viewer plugin. Cloudflare reads all of those.
 *
 * So: drive the real Google Chrome whenever the machine has one. Crawlee's `useChrome` launch
 * option already knows where to look; this module only decides *whether* to ask for it, because
 * `useChrome: true` with no Chrome installed is a hard launch failure — and a degraded-but-running
 * crawl on bundled Chromium beats a run that dies on its first page.
 *
 * On the Apify platform this resolves with no Dockerfile change: the
 * `apify/actor-node-playwright-chrome` base image installs Google Chrome Stable from Google's own
 * APT repository at /usr/bin/google-chrome, and advertises it as `APIFY_CHROME_EXECUTABLE_PATH`.
 */

/** Escape hatch: set to `1` to force the bundled Chromium, e.g. to re-measure the difference. */
const FORCE_BUNDLED = 'DHGATE_USE_BUNDLED_CHROMIUM';

/**
 * The same locations Crawlee's `useChrome` falls back to, so what we probe is what it would
 * actually launch. Kept in this order: an explicit env override first, then the platform default.
 */
function chromeCandidates(): string[] {
    const fromEnv = [
        // Crawlee's own override, honoured by `useChrome`.
        process.env.CRAWLEE_CHROME_EXECUTABLE_PATH,
        // Set by the Apify Playwright/Puppeteer base images.
        process.env.APIFY_CHROME_EXECUTABLE_PATH,
    ];

    switch (platform()) {
        case 'darwin':
            return [...fromEnv, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(isPath);
        case 'win32':
            return [
                ...fromEnv,
                `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
                `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
            ].filter(isPath);
        default:
            return [...fromEnv, '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].filter(isPath);
    }
}

function isPath(value: string | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
}

/** What {@link chooseChrome} decided, in the shape `PlaywrightCrawler` wants it. */
export interface ChromeChoice {
    /** Hand straight to `launchContext.useChrome`. */
    useChrome: boolean;
    /** Hand to `launchOptions.executablePath`. `undefined` means "bundled Chromium". */
    executablePath?: string;
    /** One line for the startup log: which binary, and why that one. */
    description: string;
}

/**
 * Pick the browser binary to launch: the real Google Chrome if one is installed, the bundled
 * Chromium otherwise. The choice is logged rather than silently applied, because it is the first
 * thing to check when the challenge rate goes up.
 */
export function chooseChrome(): ChromeChoice {
    if (process.env[FORCE_BUNDLED] === '1') {
        return {
            useChrome: false,
            description: `bundled Chromium (${FORCE_BUNDLED}=1) — expect far more Cloudflare challenges`,
        };
    }

    const candidates = chromeCandidates();
    const found = candidates.find((path) => existsSync(path));
    if (!found) {
        return {
            useChrome: false,
            description:
                `bundled Chromium — no Google Chrome found (looked in ${candidates.join(', ')}). ` +
                'Cloudflare challenges will be much more frequent; install Chrome or point ' +
                'CRAWLEE_CHROME_EXECUTABLE_PATH at one.',
        };
    }

    return { useChrome: true, executablePath: found, description: `Google Chrome at ${found}` };
}
