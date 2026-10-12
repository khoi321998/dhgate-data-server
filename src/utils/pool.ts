import { AsyncResource } from 'node:async_hooks';

/**
 * The async context of module load: outside every request. Crawlee keeps per-request state in
 * AsyncLocalStorage — among it the "this request timed out" flag that `tryCancel()` throws on — and a
 * task the pool starts inherits the context it was started from. Started from inside a request
 * handler, the next task would run in that request's context, and once that request timed out the
 * unrelated task threw at its first `tryCancel()`, failed the pool and took the whole crawler down
 * (https://github.com/apify/crawlee/issues/3670 is the same leak inside Crawlee).
 */
const outsideAnyRequest = new AsyncResource('dhgate-start-queued');

/**
 * Have the crawler pick up a request that was just queued, instead of whenever its pool next checks.
 *
 * Without this a queued request could wait for a whole page to finish even with free concurrency:
 * Crawlee's AutoscaledPool checks the queue on an interval built with `betterSetInterval` from
 * `@apify/utilities`, which since 2.x schedules the next check only once the previous one's promise
 * settles — and a check that starts a task settles when that task ends. So while a page started by
 * that check runs, nothing new starts on its own: a product's parallel store page sat in the queue
 * until the product page was done, and so did a second caller's request. `notify()` runs one check
 * right away, outside that interval — and from {@link outsideAnyRequest}, never from the caller's
 * request context.
 */
export function startQueuedNow(crawler: { autoscaledPool?: { notify: () => Promise<void> } }): void {
    outsideAnyRequest.runInAsyncScope(() => {
        void crawler.autoscaledPool?.notify();
    });
}
