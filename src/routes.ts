import type { Request } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';

import type { CaptureMode } from './dto/index.js';
import { handleProduct } from './handlers/product.js';
import { handleSeller } from './handlers/seller.js';
import type { JobUserData } from './jobs.js';
import { LABELS } from './labels.js';

// Re-export so existing importers (e.g. server.ts) keep working.
export { LABELS };

export const DEFAULT_MODE: CaptureMode = 'product_only';

/** The capture mode of the `POST /scrape` call this request belongs to. */
export function modeOf(request: Request): CaptureMode {
    return (request.userData as JobUserData).mode ?? DEFAULT_MODE;
}

/**
 * Build the router. The crawler is shared by every request, so the mode is not fixed per crawler:
 * it rides on each request's `userData` and is passed to the handlers so they can decide whether
 * to also visit the seller.
 */
export function createRouter() {
    const router = createPlaywrightRouter();

    router.addHandler(LABELS.PRODUCT, async (ctx) => handleProduct(ctx, modeOf(ctx.request)));
    router.addHandler(LABELS.SELLER, async (ctx) => handleSeller(ctx, modeOf(ctx.request)));

    return router;
}
