import { describe, expect, it } from 'vitest';

import { extractDhgateShipCountry, normalizeDhgateHost } from '../src/utils/parse.js';

describe('normalizeDhgateHost', () => {
    it('rewrites a regional subdomain to www', () => {
        expect(normalizeDhgateHost('https://es.dhgate.com/product/club-team-goalkeeper/925906109.html')).toBe(
            'https://www.dhgate.com/product/club-team-goalkeeper/925906109.html',
        );
    });

    it('leaves the canonical host untouched', () => {
        const url = 'https://www.dhgate.com/product/men-s-polos/1064214730.html';
        expect(normalizeDhgateHost(url)).toBe(url);
    });

    it('keeps the query string and hash', () => {
        expect(normalizeDhgateHost('https://fr.dhgate.com/product/x/123.html?dspm=abc#st1-0')).toBe(
            'https://www.dhgate.com/product/x/123.html?dspm=abc#st1-0',
        );
    });

    it('normalizes the mobile host too', () => {
        expect(normalizeDhgateHost('https://m.dhgate.com/product/x/123.html')).toBe(
            'https://www.dhgate.com/product/x/123.html',
        );
    });

    it('leaves non-DHGate URLs alone', () => {
        const url = 'https://example.com/product/123.html';
        expect(normalizeDhgateHost(url)).toBe(url);
    });

    it('does not match a lookalike domain', () => {
        const url = 'https://notdhgate.com/product/123.html';
        expect(normalizeDhgateHost(url)).toBe(url);
    });

    it('returns unparseable input unchanged', () => {
        expect(normalizeDhgateHost('not a url')).toBe('not a url');
    });
});

describe('extractDhgateShipCountry', () => {
    it.each([
        ['es', 'ES'],
        ['fr', 'FR'],
        ['de', 'DE'],
        ['jp', 'JP'],
        ['kr', 'KR'],
        ['se', 'SE'],
        ['ie', 'IE'],
    ])('maps the %s subdomain to %s', (subdomain, expected) => {
        expect(extractDhgateShipCountry(`https://${subdomain}.dhgate.com/product/x/123.html`)).toBe(expected);
    });

    it('defaults the canonical host to US', () => {
        expect(extractDhgateShipCountry('https://www.dhgate.com/product/x/123.html')).toBe('US');
    });

    it('defaults the Arabic host to US (no single country)', () => {
        expect(extractDhgateShipCountry('https://ar.dhgate.com/product/x/123.html')).toBe('US');
    });

    it('defaults unknown subdomains and non-DHGate hosts to US', () => {
        expect(extractDhgateShipCountry('https://zz.dhgate.com/product/x/123.html')).toBe('US');
        expect(extractDhgateShipCountry('https://example.com/product/x/123.html')).toBe('US');
        expect(extractDhgateShipCountry('not a url')).toBe('US');
    });

    it('reads the country BEFORE normalization destroys the subdomain', () => {
        const input = 'https://es.dhgate.com/product/x/123.html';
        const country = extractDhgateShipCountry(input);
        const normalized = normalizeDhgateHost(input);

        expect(country).toBe('ES');
        expect(normalized).toBe('https://www.dhgate.com/product/x/123.html');
        // The trap this guards: calling them in the wrong order silently yields US.
        expect(extractDhgateShipCountry(normalized)).toBe('US');
    });
});
