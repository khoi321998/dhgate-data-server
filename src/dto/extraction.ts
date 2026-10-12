/** `critical` = the page cannot have parsed correctly without it; `warning` = usually present. */
export type ExtractionSeverity = 'critical' | 'warning';

export type ExtractionStatus = 'ok' | 'degraded' | 'broken';

/**
 * One expected-but-absent field: what is missing, and the DOM hook it should have come from.
 * Deliberately just those two — whether the value arrived as `null` or `''` says nothing a reader
 * can act on; both mean the hook stopped matching, and the fix is the same either way.
 */
export interface ExtractionIssue {
    field: string;
    selector?: string;
}

export interface ExtractionReport {
    /** `broken` if any critical field is absent, `degraded` if only warnings, else `ok`. */
    status: ExtractionStatus;
    /** How many declared checks actually applied to this record (mode-dependent). */
    checkedFields: number;
    missingFields: string[];
    issues: ExtractionIssue[];
}
