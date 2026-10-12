import { describe, expect, it } from 'vitest';

import type { FieldCheck } from '../src/extraction-audit.js';
import { auditExtraction, emptyExtractionReport } from '../src/extraction-audit.js';

/**
 * The checks table itself is not unit-testable — it is a claim about DHGate's live markup, and
 * only a real run can confirm it (see step 7 of the audit rollout). What IS testable is the
 * engine: absence detection, severity → status, `when` gating, and null-section traversal.
 */
describe('auditExtraction', () => {
    const checks: FieldCheck[] = [
        { path: 'product.id', severity: 'critical', selector: 'URL /<id>.html' },
        { path: 'product.title', severity: 'critical', selector: 'h1[itemprop="name"]' },
        { path: 'product.specs', severity: 'warning', selector: 'dl.specs' },
        { path: 'product.soldCount', severity: 'warning' },
    ];

    const healthy = {
        product: { id: '123', title: 'A shirt', specs: [{ name: 'Color', value: 'Red' }], soldCount: 42 },
    };

    it('reports ok with every declared check counted when nothing is absent', () => {
        expect(auditExtraction(healthy, checks)).toEqual({
            status: 'ok',
            checkedFields: 4,
            missingFields: [],
            issues: [],
        });
    });

    it('treats 0 and false as real values, not absence', () => {
        const record = { product: { ...healthy.product, soldCount: 0, title: false } };
        const report = auditExtraction(record, checks);
        expect(report.status).toBe('ok');
        expect(report.missingFields).toEqual([]);
    });

    it('treats empty strings, empty arrays and empty objects as absent', () => {
        const record = { product: { id: '   ', title: 'A shirt', specs: [], soldCount: {} } };
        const report = auditExtraction(record, checks);
        expect(report.missingFields).toEqual(['product.id', 'product.specs', 'product.soldCount']);
    });

    it('treats NaN as absent but leaves other finite numbers alone', () => {
        const record = { product: { ...healthy.product, soldCount: Number.NaN } };
        expect(auditExtraction(record, checks).missingFields).toEqual(['product.soldCount']);
    });

    it('emits exactly { field, selector }, and just { field } when the check declares no selector', () => {
        const record = { product: { id: '123', title: '', specs: [{}], soldCount: null } };
        expect(auditExtraction(record, checks).issues).toEqual([
            { field: 'product.title', selector: 'h1[itemprop="name"]' },
            { field: 'product.soldCount' },
        ]);
    });

    it('is broken when a critical field is absent', () => {
        const record = { product: { ...healthy.product, id: null } };
        const report = auditExtraction(record, checks);
        expect(report.status).toBe('broken');
        expect(report.missingFields).toEqual(['product.id']);
    });

    it('is broken when critical and warning fields are absent together', () => {
        const record = { product: { id: null, title: 'A shirt', specs: [], soldCount: 42 } };
        expect(auditExtraction(record, checks).status).toBe('broken');
    });

    it('is degraded when only warnings are absent', () => {
        const record = { product: { ...healthy.product, specs: [] } };
        const report = auditExtraction(record, checks);
        expect(report.status).toBe('degraded');
        expect(report.missingFields).toEqual(['product.specs']);
    });

    it('skips a when-gated check when the gate is closed, and does not count it', () => {
        const gated: FieldCheck[] = [
            { path: 'seller.name', severity: 'critical', selector: '.sto-name', when: (r) => r.seller != null },
        ];
        expect(auditExtraction({ seller: null }, gated)).toEqual({
            status: 'ok',
            checkedFields: 0,
            missingFields: [],
            issues: [],
        });
    });

    it('counts and applies a when-gated check when the gate is open', () => {
        const gated: FieldCheck[] = [
            { path: 'seller.name', severity: 'critical', selector: '.sto-name', when: (r) => r.seller != null },
        ];
        const report = auditExtraction({ seller: { name: null } }, gated);
        expect(report).toEqual({
            status: 'broken',
            checkedFields: 1,
            missingFields: ['seller.name'],
            issues: [{ field: 'seller.name', selector: '.sto-name' }],
        });
    });

    it('reports the children of a null section as absent instead of throwing', () => {
        const report = auditExtraction({ product: null }, checks);
        expect(report.status).toBe('broken');
        expect(report.missingFields).toEqual([
            'product.id',
            'product.title',
            'product.specs',
            'product.soldCount',
        ]);
    });

    it('handles a null/undefined record without throwing', () => {
        expect(() => auditExtraction(null, checks)).not.toThrow();
        expect(auditExtraction(undefined, checks).status).toBe('broken');
    });
});

describe('emptyExtractionReport', () => {
    it('is an ok report with nothing checked', () => {
        expect(emptyExtractionReport()).toEqual({
            status: 'ok',
            checkedFields: 0,
            missingFields: [],
            issues: [],
        });
    });
});
