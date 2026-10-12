import { describe, expect, it } from 'vitest';

import { DEFAULT_PROXY, describeProxy, pickProxy } from '../src/utils/proxy.js';

describe('pickProxy', () => {
    // A run that says nothing must not be the one going out on the container's own IP — that is
    // the whole reason the switch defaults to on rather than off.
    it.each([
        ['left unset', undefined],
        ['explicitly on', true],
    ])('uses the fixed residential US exit when enableProxy is %s', (_label, enableProxy) => {
        const { settings, enabled } = pickProxy(enableProxy);
        expect(enabled).toBe(true);
        expect(settings).toBe(DEFAULT_PROXY);
        expect(settings.apifyProxyGroups).toEqual(['RESIDENTIAL']);
        expect(settings.apifyProxyCountry).toBe('US');
    });

    it('turns proxying off when enableProxy is false', () => {
        const { settings, enabled } = pickProxy(false);
        expect(enabled).toBe(false);
        expect(settings).toEqual({ useApifyProxy: false });
    });
});

describe('describeProxy', () => {
    it('names the exit the run is going out from', () => {
        expect(describeProxy(pickProxy(true))).toBe('RESIDENTIAL US');
    });
});
