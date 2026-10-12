import { AsyncLocalStorage } from 'node:async_hooks';

import { log } from 'apify';

export { log };

/** Prefix of the job running in the current async context: "url" or "url [transactionId: x]". */
const jobPrefix = new AsyncLocalStorage<string>();

export async function runWithJobPrefix<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
    return jobPrefix.run(prefix, fn);
}

/**
 * Concurrent jobs interleave in the logs, so every line logged while a job runs carries the url +
 * transactionId of that job (grep-able by transactionId).
 *
 * Every `log.child()` — Crawlee's crawler log, `ctx.log` in the handlers, the module-level `log` in
 * utils — shares the one logger instance it was created from, and most of them are created at import
 * time. So the prefix (and the timestamp) is added on that shared instance rather than by swapping in
 * a new logger with `log.setOptions`, which only the root log would see.
 */
const logger = log.getOptions().logger as {
    setOptions: (options: Record<string, unknown>) => void;
    log: (level: number, message: string, ...args: unknown[]) => void;
};
logger.setOptions({ skipTime: false });

const writeLine = logger.log.bind(logger);
logger.log = (level, message, ...args) => {
    const prefix = jobPrefix.getStore();
    writeLine(level, prefix ? `${prefix} | ${message}` : message, ...args);
};
