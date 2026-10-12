import type { ProxyInput } from '../dto/index.js';

/**
 * Where the server goes out from, set by `APIFY_PROXY_GROUPS`:
 * - empty or unset — no proxy: the machine's own IP;
 * - `DATACENTER` — Apify's datacenter proxy;
 * - `RESIDENTIAL` — Apify's residential proxy.
 *
 * On DHGate the choice matters: the site is behind Cloudflare, and a browser coming from the
 * machine's own IP draws the interactive "Verify you are human" variant far more often — and, once a
 * session is burnt, has no second IP to retry from. Residential is the exit that measured best.
 * `APIFY_PROXY_COUNTRY` (two-letter code, `US` by default, empty = any) picks the exit country.
 */
export type ProxyKind = 'NONE' | 'DATACENTER' | 'RESIDENTIAL';

/** The settings to hand `Actor.createProxyConfiguration`, plus whether a proxy is wanted at all. */
export interface ProxyChoice {
    kind: ProxyKind;
    settings: ProxyInput;
    /** `false` for {@link ProxyKind} `NONE` — no proxy is created at all. */
    enabled: boolean;
}

const DEFAULT_COUNTRY = 'US';

/** Read `APIFY_PROXY_GROUPS` / `APIFY_PROXY_COUNTRY`. Throws on a value it does not know. */
export function proxyChoiceFromEnv(env: NodeJS.ProcessEnv): ProxyChoice {
    const kind = (env.APIFY_PROXY_GROUPS ?? '').trim().toUpperCase() || 'NONE';
    if (kind !== 'NONE' && kind !== 'DATACENTER' && kind !== 'RESIDENTIAL') {
        throw new Error(
            `Env var APIFY_PROXY_GROUPS must be empty (no proxy), DATACENTER or RESIDENTIAL, got "${env.APIFY_PROXY_GROUPS}".`,
        );
    }
    if (kind === 'NONE') return { kind, settings: { useApifyProxy: false }, enabled: false };

    const country = (env.APIFY_PROXY_COUNTRY ?? DEFAULT_COUNTRY).trim().toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) {
        throw new Error(`Env var APIFY_PROXY_COUNTRY must be a two-letter country code, got "${env.APIFY_PROXY_COUNTRY}".`);
    }
    return {
        kind,
        settings: {
            useApifyProxy: true,
            // Apify's datacenter proxy is the one with no group.
            ...(kind === 'RESIDENTIAL' ? { apifyProxyGroups: ['RESIDENTIAL'] } : {}),
            ...(country ? { apifyProxyCountry: country } : {}),
        },
        enabled: true,
    };
}

/** One line for the startup log: where we are going out from. */
export function describeProxy({ kind, settings }: ProxyChoice): string {
    if (kind === 'NONE') return 'none';
    return `${kind} ${settings.apifyProxyCountry ?? '(any country)'}`;
}
