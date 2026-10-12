/** Extract the first numeric amount from a price string, e.g. "US $14.9" -> 14.9, "US $1,234.5" -> 1234.5 */
export function parseAmount(text: string | null | undefined): number | null {
    if (!text) return null;
    const match = text.replace(/,/g, '').match(/[\d.]+/);
    return match ? Number(match[0]) : null;
}

/** Extract every numeric amount from a string, e.g. "US $14.9 - 20.0" -> [14.9, 20] */
export function parseAmounts(text: string | null | undefined): number[] {
    if (!text) return [];
    return (text.replace(/,/g, '').match(/[\d.]+/g) ?? []).map(Number);
}

/** Extract the currency prefix from a price string, e.g. "US $14.9" -> "US $" */
export function parseCurrencySymbol(text: string | null | undefined): string | null {
    if (!text) return null;
    const match = text.match(/^([^\d]+?)\s*[\d.]/);
    return match ? match[1].trim() : null;
}

/** Normalize a currency symbol/label to an ISO-4217-ish code, e.g. "US $" / "$" -> "USD". */
export function normalizeCurrency(symbol: string | null | undefined): string {
    if (!symbol) return 'USD';
    const s = symbol.toUpperCase();
    if (s.includes('US $') || s.includes('USD') || s === '$') return 'USD';
    if (s.includes('€') || s.includes('EUR')) return 'EUR';
    if (s.includes('£') || s.includes('GBP')) return 'GBP';
    return symbol.trim();
}

/** Parse a compact/abbreviated count, e.g. "5K+ sold" -> 5000, "1.2M" -> 1200000, "3970" -> 3970. */
export function parseCompactNumber(text: string | null | undefined): number | null {
    if (!text) return null;
    const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KkMm])?/);
    if (!match) return null;
    let n = parseFloat(match[1]);
    if (!Number.isFinite(n)) return null;
    const suffix = match[2]?.toLowerCase();
    if (suffix === 'k') n *= 1_000;
    else if (suffix === 'm') n *= 1_000_000;
    return Math.round(n);
}

/** Pull the DHGate product id out of a product URL, e.g. ".../1064214730.html?..." -> "1064214730". */
export function extractProductId(url: string): string | null {
    const match = url.match(/\/(\d+)\.html/);
    return match ? match[1] : null;
}

/** Pull the DHGate seller/store id out of a store URL, e.g. ".../store/top-selling/21880856.html?..." -> "21880856". */
export function extractSellerId(url: string | null | undefined): string | null {
    if (!url) return null;
    const match = url.match(/\/(\d+)\.html/);
    return match ? match[1] : null;
}

/**
 * Strip the query string / hash from a URL, returning just `origin + pathname`,
 * e.g. ".../1064214730.html?dspm=...#st1-0" -> ".../1064214730.html".
 * Returns the input unchanged if it cannot be parsed as a URL.
 */
export function stripUrlParams(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url;
    }
}

/**
 * DHGate's regional hosts, taken from the `hreflang` alternates the product pages emit.
 * The subdomain selects the *language*; the ship-to country is a separate cookie, which is
 * why we can normalize the host to `www` (English markup) and still keep the regional
 * commercial context by shipping the matching country in `b2b_ship_country`.
 *
 * `ar` is deliberately absent: it selects Arabic, which maps to no single country.
 * Anything unlisted falls back to {@link DEFAULT_SHIP_COUNTRY}.
 */
const SHIP_COUNTRY_BY_SUBDOMAIN: Record<string, string> = {
    de: 'DE',
    es: 'ES',
    fr: 'FR',
    ie: 'IE',
    it: 'IT',
    jp: 'JP',
    kr: 'KR',
    nl: 'NL',
    pl: 'PL',
    pt: 'PT',
    ru: 'RU',
    se: 'SE',
    tr: 'TR',
};

/** Ship-to country used for `www`, the mobile host, and any unrecognized subdomain. */
export const DEFAULT_SHIP_COUNTRY = 'US';

/**
 * Derive the ship-to country from a DHGate URL's subdomain, e.g.
 * `https://es.dhgate.com/...` -> `"ES"`. Falls back to {@link DEFAULT_SHIP_COUNTRY} for
 * `www`, `m`, Arabic, non-DHGate hosts, and unparseable input.
 *
 * Call this BEFORE {@link normalizeDhgateHost} — normalizing destroys the subdomain.
 */
export function extractDhgateShipCountry(url: string): string {
    try {
        const { hostname } = new URL(url);
        if (!/(^|\.)dhgate\.com$/i.test(hostname)) return DEFAULT_SHIP_COUNTRY;
        const [subdomain] = hostname.toLowerCase().split('.');
        return SHIP_COUNTRY_BY_SUBDOMAIN[subdomain] ?? DEFAULT_SHIP_COUNTRY;
    } catch {
        return DEFAULT_SHIP_COUNTRY;
    }
}

/**
 * Decide which country to ship to for one start URL.
 *
 * Precedence, most explicit first:
 * 1. `shipToCountry` from the Actor input — one country for the whole run;
 * 2. the URL's own subdomain ({@link extractDhgateShipCountry}) — lets a mixed list of
 *    regional URLs each keep its own market;
 * 3. {@link DEFAULT_SHIP_COUNTRY}.
 *
 * An input that is not a two-letter code is rejected rather than passed to DHGate, where a
 * bad value would silently fall back to some country we did not choose. `onInvalid` is
 * called so the caller can log it.
 */
export function resolveShipCountry(
    shipToCountry: string | undefined,
    url: string,
    onInvalid?: (value: string) => void,
): string {
    const explicit = shipToCountry?.trim().toUpperCase();
    if (explicit) {
        if (/^[A-Z]{2}$/.test(explicit)) return explicit;
        onInvalid?.(explicit);
    }
    return extractDhgateShipCountry(url);
}

/**
 * Force a DHGate URL onto the canonical `www` host.
 *
 * Regional subdomains (`es.`, `fr.`, `de.`, …) serve the same product under the same id, but:
 * - they render in the local language, and the `language=en` cookie does NOT override the
 *   subdomain — so the English-keyed extractors would silently return empty/wrong values;
 * - they sit behind their own Cloudflare challenge (clearance is per hostname).
 *
 * The regional context is not lost: {@link extractDhgateShipCountry} turns the subdomain into
 * a ship-to country, which the caller applies as a cookie.
 *
 * Non-DHGate or unparseable URLs are returned unchanged.
 */
export function normalizeDhgateHost(url: string): string {
    try {
        const parsed = new URL(url);
        if (!/(^|\.)dhgate\.com$/i.test(parsed.hostname)) return url;
        if (parsed.hostname.toLowerCase() === 'www.dhgate.com') return url;
        parsed.hostname = 'www.dhgate.com';
        return parsed.toString();
    } catch {
        return url;
    }
}

/** Normalize a DHGate image src: prefix protocol-relative `//...` URLs with `https:`. Returns null for empty input. */
export function normalizeImageUrl(src: string | null | undefined): string | null {
    if (!src) return null;
    return src.startsWith('//') ? `https:${src}` : src;
}
