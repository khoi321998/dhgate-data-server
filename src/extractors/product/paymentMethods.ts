import { log } from 'apify';
import type { Page } from 'playwright';

/** The API the "Buyer Protection" modal itself calls for its payment logos. */
export const PAYMENT_ICONS_API = 'https://shoppingcart.dhgate.com/order/getPaymentMethodIcons.do';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Extract the accepted payment methods (as logo image URLs).
 *
 * They are the logos of the "Buyer Protection" modal (`[spm-c="buyPtc"]`), which are not in the
 * page: the modal's own script fetches them from {@link PAYMENT_ICONS_API} for the buyer's ship-to
 * country and fills `.j-paymentListImg` with one `<img>` per `data.paymentList[].logo`. Opening the
 * modal to wait for that — click, poll every frame, press Escape — cost up to 10 s and left the modal
 * up when Escape did not close it, so the same request is made here instead, from the page, with
 * its cookies and through its proxy, exactly as the modal makes it. Filenames are not a reliable
 * naming scheme (e.g. "klarna2024", "Google_Pay"), so the URLs are kept as-is.
 */
export async function extractPaymentMethods(page: Page): Promise<string[]> {
    const startedAt = Date.now();
    // No named functions inside: `tsx` (esbuild) wraps them in `__name(...)`, which the page lacks.
    const result = await page
        .evaluate(
            async ({ api, timeoutMs }) => {
                const shipToCountry = /(?:^|;\s*)b2b_ship_country=([^;]*)/.exec(document.cookie)?.[1] ?? '';
                const language = /(?:^|;\s*)language=([^;]*)/.exec(document.cookie)?.[1] ?? 'en';
                const url = `${api}?shipToCountry=${shipToCountry}&buyerId=&language=${language}&client=pc`;
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(), timeoutMs);
                try {
                    const res = await fetch(url, { credentials: 'include', mode: 'cors', signal: ac.signal });
                    const body = (await res.json()) as {
                        state?: string;
                        data?: { paymentList?: { logo?: string }[] };
                    };
                    if (body.state !== '0x0000') return { error: `API answered state ${body.state ?? '?'}` };
                    return { logos: (body.data?.paymentList ?? []).map((item) => item.logo ?? '') };
                } catch (error) {
                    return { error: (error as Error).message };
                } finally {
                    clearTimeout(timer);
                }
            },
            { api: PAYMENT_ICONS_API, timeoutMs: REQUEST_TIMEOUT_MS },
        )
        .catch((error: Error) => ({ error: error.message.split('\n')[0] }));

    const millis = Date.now() - startedAt;
    if ('error' in result) {
        log.warning(`[paymentMethods] no payment logos — ${result.error}`, { millis });
        return [];
    }

    const urls: string[] = [];
    for (const logo of result.logos) {
        if (logo && !urls.includes(logo)) urls.push(logo);
    }
    if (urls.length === 0) log.warning('[paymentMethods] the API listed no payment methods', { millis });
    return urls;
}
