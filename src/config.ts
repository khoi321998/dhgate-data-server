/** Settings read from the environment that more than the server entry point needs. */

export function intEnv(name: string, fallback: number, min = 1): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) throw new Error(`Env var ${name} must be an integer >= ${min}, got "${raw}".`);
    return value;
}

/**
 * Retries per request after the first attempt. Each one runs in a new browser on a new session, so a
 * new proxy IP. The product handler reads it to know whether a failed store page can still be retried.
 */
export const MAX_REQUEST_RETRIES = intEnv('MAX_REQUEST_RETRIES', 3, 0);

/** `PARALLEL_SELLER=false` opens the store page only after the product page is done. */
export const PARALLEL_SELLER = process.env.PARALLEL_SELLER !== 'false';
