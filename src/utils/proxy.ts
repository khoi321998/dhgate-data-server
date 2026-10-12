import type { ProxyInput } from '../dto/index.js';

/**
 * Where this run goes out from is decided here, in code, not by the input. On DHGate the proxy is
 * not really a preference: the site is behind Cloudflare, and a run coming from the container's own
 * IP draws the interactive "Verify you are human" variant far more often — and, once a session is
 * burnt, has no second IP to retry from. Residential US is the exit that measured best, so that is
 * what every proxied run gets.
 *
 * The input keeps exactly one lever over this, `enableProxy`: on, and the settings below are used;
 * off, and no proxy is created at all. Anything more granular (groups, country, custom URLs) would
 * be a knob whose only sensible position is the one already set here.
 */

/** The one proxy configuration this Actor uses, whenever `enableProxy` is on. */
export const DEFAULT_PROXY: ProxyInput = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
    apifyProxyCountry: 'US',
};

/** The settings to hand `Actor.createProxyConfiguration`, plus whether a proxy is wanted at all. */
export interface ProxyChoice {
    settings: ProxyInput;
    /** `false` when `enableProxy: false` turned proxying off — no proxy is created at all. */
    enabled: boolean;
}

/**
 * @param enableProxy the `enableProxy` input. Defaults to on, because a run that says nothing about
 *   proxies on a Cloudflare-fronted site should not be the one going out bare.
 */
export function pickProxy(enableProxy = true): ProxyChoice {
    if (!enableProxy) return { settings: { useApifyProxy: false }, enabled: false };
    return { settings: DEFAULT_PROXY, enabled: true };
}

/** One line for the startup log: where we are going out from. */
export function describeProxy({ settings }: ProxyChoice): string {
    const groups = settings.apifyProxyGroups?.join('+') ?? settings.groups?.join('+');
    const where = groups ?? (settings.proxyUrls?.length ? 'custom URLs' : 'AUTO');
    const country = settings.apifyProxyCountry ?? settings.countryCode ?? '(no country)';
    return `${where} ${country}`;
}
