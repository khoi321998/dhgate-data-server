import { describe, expect, it } from 'vitest';

import {
    asWebp,
    availableQuantity,
    availableQuantityFromSkuPrice,
    deliveryTextFromShipping,
    pricingFromFlightData,
    readFlightData,
} from '../src/extractors/product/http.js';

describe('readFlightData', () => {
    it('joins the RSC chunks in order, unescaped', () => {
        const html = [
            '<script>self.__next_f.push([0])</script>',
            '<script>self.__next_f.push([1,"{\\"a\\":1,"])</script>',
            '<script>self.__next_f.push([1,"\\"b\\":\\"x\\\\\\"y\\"}"])</script>',
        ].join('');
        expect(readFlightData(html)).toBe('{"a":1,"b":"x\\"y"}');
    });

    it('is empty without flight data', () => {
        expect(readFlightData('<html></html>')).toBe('');
    });
});

describe('pricingFromFlightData', () => {
    it('takes the new-buyer price when the page shows it', () => {
        const rsc = '"showNewBuyerPrice":true,"dealMinBuyerPrice":3.1,"dealMaxBuyerPrice":5,"dealMaxMinBuyerPrice":2.5';
        expect(pricingFromFlightData(rsc)).toEqual({ currency: 'USD', priceMin: 2.5, priceMax: 2.5 });
    });

    it('takes the deal range otherwise', () => {
        const rsc = '"showNewBuyerPrice":false,"dealMinBuyerPrice":3.1,"dealMaxBuyerPrice":5';
        expect(pricingFromFlightData(rsc)).toEqual({ currency: 'USD', priceMin: 3.1, priceMax: 5 });
    });

    it('gives up on a missing or inverted range', () => {
        expect(pricingFromFlightData('"dealMinBuyerPrice":3')).toBeNull();
        expect(pricingFromFlightData('"dealMinBuyerPrice":6,"dealMaxBuyerPrice":5')).toBeNull();
        expect(pricingFromFlightData('"showNewBuyerPrice":true')).toBeNull();
    });
});

describe('availableQuantityFromSkuPrice', () => {
    it('takes the lower of the promotion limit and the inventory', () => {
        expect(availableQuantityFromSkuPrice({ promoLimitNum: 5, inventoryNum: 120 })).toBe(5);
        expect(availableQuantityFromSkuPrice({ inventoryNum: 120 })).toBe(120);
    });

    it('is null without either', () => {
        expect(availableQuantityFromSkuPrice({})).toBeNull();
        expect(availableQuantityFromSkuPrice(null)).toBeNull();
    });
});

describe('availableQuantity', () => {
    it('takes the label the page was served with', () => {
        expect(availableQuantity('9999 in stock', { promoLimitNum: 1 })).toBe(9999);
        expect(availableQuantity('83 in stock', { inventoryNum: 17 })).toBe(83);
    });

    it('replaces the "0" placeholder with the API figure', () => {
        expect(availableQuantity('0 in stock', { inventoryNum: 17 })).toBe(17);
        expect(availableQuantity('0 in stock', {})).toBe(0);
    });

    it('is null without a label', () => {
        expect(availableQuantity(null, { inventoryNum: 17 })).toBeNull();
    });
});

describe('deliveryTextFromShipping', () => {
    it('shows a promised delivery as days', () => {
        expect(deliveryTextFromShipping([{ promiseDeliveryType: 1, promiseDelivery: 7, lowerDate: 'Oct 20' }])).toBe(
            '7 Days Delivery',
        );
    });

    it('shows the date range otherwise', () => {
        expect(deliveryTextFromShipping([{ lowerDate: 'Oct 20', upperDate: 'Nov 02' }])).toBe('Oct 20 - Nov 02');
        expect(deliveryTextFromShipping([{ lowerDate: 'Oct 20', upperDate: 'Oct 20' }])).toBe('Oct 20');
        expect(deliveryTextFromShipping([{ upperDate: 'Nov 02' }])).toBe('Nov 02');
    });

    it('is null without a route', () => {
        expect(deliveryTextFromShipping([])).toBeNull();
        expect(deliveryTextFromShipping({})).toBeNull();
    });
});

describe('asWebp', () => {
    it('serves a DHGate image as webp, once', () => {
        expect(asWebp('https://image.dhgate.com/a/b.jpg')).toBe('https://image.dhgate.com/webp/m/0x0/a/b.jpg');
        expect(asWebp('https://image.dhgate.com/webp/m/0x0/a/b.jpg')).toBe('https://image.dhgate.com/webp/m/0x0/a/b.jpg');
    });

    it('leaves other hosts alone', () => {
        expect(asWebp('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
    });
});
