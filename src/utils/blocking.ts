import { playwrightUtils } from '@crawlee/playwright';
import type { Page } from 'playwright';

/**
 * What a page of ours does not need to download. Matched as substrings of the URL, in the browser
 * (CDP `Network.setBlockedURLs`), so blocked requests never reach the proxy.
 *
 * Every request goes out through the proxy, and under load the residential exit drops some of them
 * (`ERR_TUNNEL_CONNECTION_FAILED`, 429). When the one dropped is a Next.js chunk or API call, DHGate's
 * app crashes into "Application error" (`ChunkLoadError`, an API `onSuccess` handed `undefined`).
 * Images, video, fonts and third-party trackers are most of a product page's requests and none of its
 * data — the extractors read image and video URLs off attributes, never the files — so leaving them
 * out leaves fewer requests to drop, and a faster page.
 *
 * Deliberately not blocked: CSS (the extractors wait for elements to be visible and click and scroll
 * to them, which needs layout), any script of DHGate's own, and anything of Cloudflare's.
 */
const BLOCKED_URL_PATTERNS = [
    // Images: the extractors read `src` / `data-*` attributes, which are there without the file.
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.avif',
    '.ico',
    // Video and audio.
    '.mp4',
    '.webm',
    '.m3u8',
    '.mp3',
    // DHGate's SVG icons (header, footer, service badges). `*` matches anything in between.
    'dhresource.com*.svg',
    // Fonts.
    '.woff',
    '.ttf',
    '.otf',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    // DHGate's own telemetry: error reports, page-performance beacons, click / view tracking. Not its
    // data APIs (`dg.`, `leo.`, `mrd.`, `www.dhgate.com` XHRs), even the ones nothing here reads: the
    // Next.js app crashes when one of those fails (an `onSuccess` handed `undefined` was seen doing it).
    'sentry.dhgate.com',
    'go-mpulse.net',
    'd1.dhgate.com/track',
    'sgtm.dhgate.com',
    // The Google Translate widget on store pages (~100 KB of script).
    'translate.google',
    'translate-pa.googleapis.com',
    // Third-party trackers and ads.
    'google-analytics.com',
    'googletagmanager.com',
    'googleadservices.com',
    'doubleclick.net',
    'connect.facebook.net',
    'facebook.com/tr',
    'getblue.io',
    'bat.bing.com',
    'clarity.ms',
    'criteo.',
    'analytics.tiktok.com',
    'hotjar.',
    'pinterest.com/ct',
    'sc-static.net',
    'snapchat.com',
    'taboola.com',
    'outbrain.com',
    'amazon-adsystem.com',
    'redditstatic.com',
    'reddit.com/rp',
    'trmit.com',
    'creativecdn.com',
    'upsellit.com',
    'axvdata.com',
    'bxtag.com',
    'matycube.net',
    'applovin.com',
    'pxaction.com',
    'altopd.com',
];

/** Block {@link BLOCKED_URL_PATTERNS} on `page`. Call before its first navigation. */
export async function blockUnneededRequests(page: Page): Promise<void> {
    await playwrightUtils.blockRequests(page, { urlPatterns: BLOCKED_URL_PATTERNS });
}
