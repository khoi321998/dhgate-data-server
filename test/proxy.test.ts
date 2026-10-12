import { describe, expect, it } from 'vitest';

import { describeProxy, proxyChoiceFromEnv } from '../src/utils/proxy.js';

describe('proxyChoiceFromEnv', () => {
    it.each([
        ['unset', undefined],
        ['empty', ''],
        ['blank', '  '],
    ])('uses no proxy when APIFY_PROXY_GROUPS is %s', (_label, groups) => {
        const choice = proxyChoiceFromEnv({ APIFY_PROXY_GROUPS: groups });
        expect(choice.enabled).toBe(false);
        expect(choice.settings).toEqual({ useApifyProxy: false });
        expect(describeProxy(choice)).toBe('none');
    });

    it('uses the datacenter proxy (no group) for DATACENTER, US by default', () => {
        const choice = proxyChoiceFromEnv({ APIFY_PROXY_GROUPS: 'DATACENTER' });
        expect(choice.enabled).toBe(true);
        expect(choice.settings).toEqual({ useApifyProxy: true, apifyProxyCountry: 'US' });
        expect(describeProxy(choice)).toBe('DATACENTER US');
    });

    it('uses the residential group only for RESIDENTIAL, case-insensitively', () => {
        const choice = proxyChoiceFromEnv({ APIFY_PROXY_GROUPS: 'residential', APIFY_PROXY_COUNTRY: 'de' });
        expect(choice.settings).toEqual({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'DE' });
        expect(describeProxy(choice)).toBe('RESIDENTIAL DE');
    });

    it('takes an empty country as "any"', () => {
        const choice = proxyChoiceFromEnv({ APIFY_PROXY_GROUPS: 'DATACENTER', APIFY_PROXY_COUNTRY: '' });
        expect(choice.settings).toEqual({ useApifyProxy: true });
        expect(describeProxy(choice)).toBe('DATACENTER (any country)');
    });

    it('rejects anything else', () => {
        expect(() => proxyChoiceFromEnv({ APIFY_PROXY_GROUPS: 'AUTO' })).toThrow(/DATACENTER or RESIDENTIAL/);
        expect(() => proxyChoiceFromEnv({ APIFY_PROXY_GROUPS: 'RESIDENTIAL', APIFY_PROXY_COUNTRY: 'USA' })).toThrow(
            /two-letter/,
        );
    });
});
