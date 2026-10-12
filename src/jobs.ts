import type { Request } from '@crawlee/playwright';

import type { CaptureMode, ProductSellerResponse } from './dto/index.js';
import { log } from './logger.js';

/**
 * One `POST /scrape` call, from the moment it is accepted until the crawler produces its row.
 *
 * The crawler is long-lived and shared by every request, so the HTTP side and the crawl side meet
 * here: the request carries `userData.jobId`, and the handler that pushes its row completes the job
 * by that id. Every attempt of a request runs in a new browser.
 */
export interface Job {
    id: string;
    /** The url as the caller sent it — what the logs and the error responses report. */
    url: string;
    /** Optional id from the caller, logged with every line of this job so backend and server logs can be matched. */
    transactionId?: string;
    mode: CaptureMode;
    enqueuedAt: number;
    /** When the crawler first picked one of this job's requests up. */
    startedAt?: number;
    /** HTTP status of the last navigation that failed for good, for the failed response. */
    statusCode?: number | null;
    /** Queue entries this job created, dropped once the job is done. */
    requestIds: Set<string>;
    result: Promise<ProductSellerResponse>;
}

/** The `userData` every request of a job carries. */
export interface JobUserData {
    jobId?: string;
    mode?: CaptureMode;
}

const jobs = new Map<string, Job>();
const resolvers = new Map<string, (row: ProductSellerResponse) => void>();

/** "url" or "url [transactionId: x]" - every log line of a job starts with this. */
export function describeJob(job: Pick<Job, 'url' | 'transactionId'>): string {
    return job.transactionId ? `${job.url} [transactionId: ${job.transactionId}]` : job.url;
}

export function createJob(fields: Pick<Job, 'id' | 'url' | 'transactionId' | 'mode'>): Job {
    let resolve!: (row: ProductSellerResponse) => void;
    const result = new Promise<ProductSellerResponse>((r) => {
        resolve = r;
    });
    const job: Job = {
        ...fields,
        enqueuedAt: Date.now(),
        requestIds: new Set(),
        result,
    };
    jobs.set(job.id, job);
    resolvers.set(job.id, resolve);
    return job;
}

/** The job a crawler request belongs to, or `undefined` when it has none (or it was already dropped). */
export function jobOf(request: Request): Job | undefined {
    const { jobId } = request.userData as JobUserData;
    return jobId ? jobs.get(jobId) : undefined;
}

/** Whether the request was enqueued for a job that no longer waits for it (timed out). */
export function isOrphan(request: Request): boolean {
    const { jobId } = request.userData as JobUserData;
    return jobId !== undefined && !jobs.has(jobId);
}

/** Hand the job's final row to the waiting HTTP request. */
export function completeJob(request: Request, row: ProductSellerResponse): void {
    const { jobId } = request.userData as JobUserData;
    const resolve = jobId ? resolvers.get(jobId) : undefined;
    if (!jobId || !resolve) {
        log.warning(`Dropping a row nobody is waiting for (job ${jobId ?? 'none'}, ${request.url})`);
        return;
    }
    resolve(row);
    dropJob(jobId);
}

/** Forget the job: a row produced for it later is dropped, and its pending requests are skipped. */
export function dropJob(jobId: string): void {
    jobs.delete(jobId);
    resolvers.delete(jobId);
}

export function jobCount(): number {
    return jobs.size;
}
