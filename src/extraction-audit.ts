/*
Extraction health audit.

Selector rot is the failure mode of this scraper: DHGate ships a markup change, a selector stops
matching, the field is written as `null`/`''`/`[]`, and the run still "succeeds". Every field we
expect to find is declared once in the table below, and the assembled record is walked against it
right before it is pushed. Adding a field to watch = one line in the table.
*/
import type { Log } from '@crawlee/playwright';

import type {
    ExtractionIssue,
    ExtractionReport,
    ExtractionSeverity,
    ExtractionStatus,
} from './dto/index.js';

/** Any pushed record — checks address it by dot path, not by concrete type. */
type RecordLike = Record<string, unknown>;

/** One declared expectation about the shape of a pushed record. */
export interface FieldCheck {
    /** Dot path into the record, e.g. `product.pricing.priceMin`. */
    path: string;
    severity: ExtractionSeverity;
    /** DOM hook the value comes from — copied into the issue so the fix site is obvious. */
    selector?: string;
    /** Skip the check unless this passes — scopes a check to a capture mode / section. */
    when?: (record: RecordLike) => boolean;
}

export function emptyExtractionReport(): ExtractionReport {
    return { status: 'ok', checkedFields: 0, missingFields: [], issues: [] };
}

function getByPath(record: unknown, path: string): unknown {
    // `acc == null ? acc : ...` so a whole null section reports its children absent, not throws.
    return path.split('.').reduce<unknown>((acc, key) => (acc == null ? acc : (acc as RecordLike)[key]), record);
}

/**
 * A dead selector produces any of these depending on how the call site defaults. `0` and `false`
 * are real values (a product can have 0 sold) and never count as absent.
 */
function isAbsent(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return !value.trim();
    if (Array.isArray(value)) return !value.length;
    if (typeof value === 'number') return Number.isNaN(value);
    if (typeof value === 'object') return !Object.keys(value as object).length;
    return false;
}

/** Walk `record` against `checks` and return the report. */
export function auditExtraction(record: unknown, checks: FieldCheck[]): ExtractionReport {
    const issues: ExtractionIssue[] = [];
    let checkedFields = 0;
    let criticalMissing = false;

    for (const check of checks) {
        if (check.when && !check.when((record ?? {}) as RecordLike)) continue;
        checkedFields++;
        if (!isAbsent(getByPath(record, check.path))) continue;
        if (check.severity === 'critical') criticalMissing = true;
        issues.push({
            field: check.path,
            ...(check.selector ? { selector: check.selector } : {}),
        });
    }

    let status: ExtractionStatus = 'ok';
    if (criticalMissing) status = 'broken';
    else if (issues.length) status = 'degraded';

    return { status, checkedFields, missingFields: issues.map((i) => i.field), issues };
}

/** Surface the report in the run log — `broken` records are worth an error-level line. */
export function logExtractionReport(report: ExtractionReport, log: Log, url: string): void {
    if (report.status === 'ok') {
        log.debug(`extraction ok (${report.checkedFields} fields checked)`, { url });
        return;
    }
    const detail = { url, status: report.status, missingFields: report.missingFields };
    if (report.status === 'broken') {
        log.error(
            `extraction BROKEN — ${report.missingFields.length}/${report.checkedFields} expected fields absent, likely a DOM change`,
            detail,
        );
    } else {
        log.warning(
            `extraction degraded — ${report.missingFields.length}/${report.checkedFields} expected fields absent`,
            detail,
        );
    }
}

/*
 * ---------------------------------------------------------------------------
 * The checks table.
 *
 * One record shape is pushed (`ProductSellerResponse`), but which half of it is populated depends
 * on the capture mode, so the two sections are gated on their own presence rather than on the
 * mode string: `product_only` leaves `seller` null, `seller_only` leaves `product` null.
 *
 * `critical` is reserved for fields a live page cannot lack — the identifiers, the title, the
 * price. Everything a healthy page may legitimately omit is either `warning` or absent from the
 * table entirely; a check that fires on a healthy page trains everyone to ignore the report.
 * ---------------------------------------------------------------------------
 */

const hasProduct = (r: RecordLike) => r.product != null;
const hasSeller = (r: RecordLike) => r.seller != null;

/** The PDP headline says there are reviews, so the review API should have returned some. */
const productHasReviewCount = (r: RecordLike) => {
    const count = getByPath(r, 'product.reviewsSummary.reviewCount');
    return typeof count === 'number' && count > 0;
};

/** We reached the store's Review tab and parsed its score table, so review cards should be there. */
const reachedSellerReviewTab = (r: RecordLike) => hasSeller(r) && getByPath(r, 'seller.reviewScore') != null;

export const ITEM_CHECKS: FieldCheck[] = [
    // --- Product core: a live PDP always has these. -------------------------------------------
    {
        path: 'product.id',
        severity: 'critical',
        selector: 'URL path /product/<slug>/<id>.html',
        when: hasProduct,
    },
    {
        path: 'product.title',
        severity: 'critical',
        selector: '[data-section="SectionProductTitle"] h1 | h1[itemprop="name"]',
        when: hasProduct,
    },
    {
        path: 'product.pricing.priceMin',
        severity: 'critical',
        selector: 'b matching /\\$\\s*[\\d.,]+/ (buy-box price)',
        when: hasProduct,
    },

    // --- Product detail: present on the overwhelming majority of PDPs. ------------------------
    {
        path: 'product.media.images',
        severity: 'warning',
        selector: 'ul[spm-c="imagelist"] img',
        when: hasProduct,
    },
    {
        path: 'product.specifications',
        severity: 'warning',
        selector: '[data-section="SectionProductSpecifications"] dl > dt/dd',
        when: hasProduct,
    },
    {
        path: 'product.description.html',
        severity: 'warning',
        selector: '[spm-c="seeall_discription"], [spm-c="seeless_discription"] → sibling <div>',
        when: hasProduct,
    },
    {
        path: 'product.paymentMethods',
        severity: 'warning',
        selector: '[spm-c="buyPtc"] → modal frame .j-paymentListImg .paymentitem img',
        when: hasProduct,
    },
    {
        path: 'product.deliveryTimeText',
        severity: 'warning',
        selector: '[spm-index="shipping"]:has-text("Estimated delivery") > div:nth(1) span',
        when: hasProduct,
    },
    {
        path: 'product.reviewsSummary.rating',
        severity: 'warning',
        selector: '#starLevel',
        when: hasProduct,
    },
    {
        // Only checked when the headline claims reviews exist — a genuinely review-less
        // product must not be reported as a broken review fetch.
        path: 'product.reviewsSummary.reviewSamples',
        severity: 'warning',
        selector: 'in-page fetch → /reviewbuyer/reviewOfProd/pageReviewOfProd → data.data[]',
        when: productHasReviewCount,
    },

    // --- Seller: only populated in seller-bearing modes. ---------------------------------------
    {
        path: 'seller.platformSellerId',
        severity: 'critical',
        selector: 'store URL path /store/.../<id>.html',
        when: hasSeller,
    },
    {
        path: 'seller.name',
        severity: 'critical',
        selector: '.sto-name | PDP [spm-c="soldby"] a[spm-index="store"] b',
        when: hasSeller,
    },
    {
        path: 'seller.avatarUrl',
        severity: 'warning',
        selector: '.storelogo img | PDP a[spm-index="store"] img',
        when: hasSeller,
    },
    {
        path: 'seller.positiveFeedbackPercent',
        severity: 'warning',
        selector: 'a[spm-c="positive feedback"] | .seller-information-warp .feedback-info li | PDP .LyovOX6 span',
        when: hasSeller,
    },
    {
        path: 'seller.transactions',
        severity: 'warning',
        selector: 'a[spm-c="Transactions"] | .seller-information-warp .feedback-info li',
        when: hasSeller,
    },
    {
        path: 'seller.productPreviews',
        severity: 'warning',
        selector: '#storeNav a[spm-c="onctopsell"] → #proGallery .gitem',
        when: hasSeller,
    },
    {
        path: 'seller.reviewScore',
        severity: 'warning',
        selector: 'a[spm-c="oncreview"][href*="seller-feedback"] → .review-score tr:has(.a1|.a2|.a3) td:last-child',
        when: hasSeller,
    },
    {
        // Gated on the score table having parsed: that proves we reached the Review tab, so an
        // empty card list there is rot rather than a store that has never been reviewed.
        //
        // Only the Positive bucket is checked. The tab's Dates filter stays on "Last 30 days",
        // so a healthy store can genuinely have no neutral or negative review in the window —
        // checking those would fire on good pages and train everyone to ignore the report.
        path: 'seller.positiveReviewSamples',
        severity: 'warning',
        selector: '.review-type-option a[data-status="1"] → .review-list-pro',
        when: reachedSellerReviewTab,
    },
];
