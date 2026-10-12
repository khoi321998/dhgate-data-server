import type { Request } from '@crawlee/playwright';

/**
 * The URL to report back in the output row.
 *
 * Crawling happens against the normalized URL (regional host rewritten to `www` — see
 * `normalizeDhgateHost` in server.ts), but the caller asked about the URL *they* passed in:
 * echoing our rewrite back would make the row hard to join against their own input. The
 * original is carried as `userData.inputUrl`; everything else — id parsing, not-found
 * detection, logs — keeps using the URL actually visited.
 */
export function reportedUrl(request: Request): string {
    const { inputUrl } = request.userData as { inputUrl?: string };
    return inputUrl ?? request.loadedUrl ?? request.url;
}
