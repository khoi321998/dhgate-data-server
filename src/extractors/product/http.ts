import type { Log } from '@crawlee/playwright';
import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';

import type { Description, Media, Pricing, Product, Specification } from '../../dto/index.js';
import { emptyProduct } from '../../utils/defaults.js';
import type { HttpClient } from '../../utils/http.js';
import { describeHttpError } from '../../utils/http.js';
import {
    extractProductId,
    extractSellerId,
    normalizeDhgateHost,
    normalizeImageUrl,
    parseAmount,
    parseCompactNumber,
    stripUrlParams,
} from '../../utils/parse.js';
import { toFullSize } from './media.js';
import { PAYMENT_ICONS_API } from './paymentMethods.js';
import type { RawReview } from './reviews.js';
import { mapReview, REVIEWS_API } from './reviews.js';
import type { SellerInline } from './seller.js';

/** Review samples kept per star, as on the browser path. */
const REVIEWS_PER_STAR = 5;

/** The product, why there is none, or why the HTTP path gave up — then the browser takes over. */
export type ProductHttpResult =
    | { kind: 'product'; product: Product; sellerInline: SellerInline | null; storeUrl: string | null }
    | { kind: 'notFound'; reason: string }
    | { kind: 'failed'; reason: string };

/**
 * Scrape the product page without a browser: its HTML, plus the JSON APIs the page itself calls once
 * it runs. Requests go through impit, which DHGate's Akamai lets through where Node's own client gets
 * 403 (see `createHttpClient`).
 *
 * Where the data comes from:
 * - the HTML: title, specifications, images, description, rating, review count, sold count, store link;
 * - the page's RSC flight data (`self.__next_f.push(…)`): price, video, default SKU, seller identity;
 * - `pcskuprice.do`: the stock, when the HTML's "N in stock" label is still its "0" placeholder;
 * - `ship.do`: the delivery estimate ("15 Days Delivery" or "Oct. 24 - Oct. 28");
 * - `pageReviewOfProd` (once per star): rating breakdown and review samples;
 * - `getPaymentMethodIcons.do`: payment logos.
 *
 * Compared field by field with the browser path (28 products, two sellers), every field matched, with
 * two known differences — and the stock label, which DHGate itself renders differently from one visit
 * to the next (9999 on one, the promotion limit of 1 on another), on either path: the description's links come without the tracking DHGate's scripts
 * add once the page runs, and the seller's badges are not on the page — the "About the Store" block
 * that shows them is client-rendered, and its texts come from DHGate's scripts — so the row gets the
 * store page's badges instead (see `mergeSellerPart`).
 *
 * Anything this was not checked against — a refusal, a challenge, a price shown some other way, an
 * API that fails twice — gives up (`failed`) rather than guess, and the browser path scrapes the
 * product instead. Never throws.
 */
export async function scrapeProductOverHttp(
    url: string,
    shipCountry: string,
    client: HttpClient,
    log: Log,
    /** Called with the store URL as soon as the HTML is read, so the store can be scraped alongside. */
    onStoreUrl?: (storeUrl: string) => void,
): Promise<ProductHttpResult> {
    const startedAt = Date.now();
    try {
        const response = await client.fetch(url);
        const html = await response.text();
        const htmlMs = Date.now() - startedAt;
        const loadedUrl = response.url || url;
        // The same order and wording as `detectNotFound` on the browser path.
        if (response.status === 404 || response.status === 410) {
            return { kind: 'notFound', reason: `DHGate answered HTTP ${response.status} for this product URL` };
        }
        if (response.status >= 400) return { kind: 'failed', reason: `HTTP ${response.status}` };
        if (isRefusalOrChallenge(html)) return { kind: 'failed', reason: 'refused or challenged' };
        if (!/\/product\/.*\/\d+\.html/.test(loadedUrl)) {
            return { kind: 'notFound', reason: `not a DHGate product page: ${loadedUrl}` };
        }
        if (/<html[^>]*id="__next_error__"/.test(html) || /<title>\s*404\b/.test(html)) {
            return { kind: 'notFound', reason: 'DHGate rendered its 404 page instead of the product' };
        }
        if (html.includes('pcen.error') || /item\s+doesn.{0,8}t\s+exist/i.test(html)) {
            return { kind: 'notFound', reason: 'DHGate rendered its "item doesn\'t exist" page instead of the product' };
        }

        const $ = load(html);
        const rsc = readFlightData(html);
        const title = readTitle($);
        if (!title) return { kind: 'failed', reason: 'no title in the HTML' };
        const pricing = pricingFromFlightData(rsc);
        if (!pricing) return { kind: 'failed', reason: 'the price is shown in a way not checked against the browser' };
        const storeUrl = readStoreUrl($, loadedUrl);
        if (storeUrl) onStoreUrl?.(storeUrl);
        const itemCode = extractProductId(loadedUrl) ?? '';
        const skuId = /"skuId":"(\d+)"/.exec(rsc)?.[1] ?? '';
        const stockCountry = /"stockCountryId":"([A-Z]+)"/.exec(rsc)?.[1] ?? 'CN';

        // The page's own API calls. All of them, or the browser does it.
        const [skuPrice, shipping, payment, ...stars] = await Promise.all([
            getJson(
                client,
                `https://www.dhgate.com/prod/ajax/pcskuprice.do?lang=en&itemCode=${itemCode}&client=pc&dispCurrency=USD&skuId=${skuId}&stockCountry=${stockCountry}&shipToCountry=${shipCountry}&url_f=&url_r=`,
            ),
            getJson(
                client,
                `https://www.dhgate.com/prod/ajax/ship.do?language=en&itemCode=${itemCode}&client=pc&wc=1111&dispCurrency=USD&quantity=1&stockCountry=&country=${shipCountry}&ifCustom=&url_f=&url_r=`,
            ),
            getJson(client, `${PAYMENT_ICONS_API}?shipToCountry=${shipCountry}&buyerId=&language=en&client=pc`),
            ...[1, 2, 3, 4, 5].map(async (score) =>
                getJson(
                    client,
                    `${REVIEWS_API}?itemCode=${encodeURIComponent(itemCode)}&language=en&client=pc&dispCurrency=USD` +
                        `&tagName=&sortType=1&pageNum=1&pageSize=${REVIEWS_PER_STAR}&isBot=&score=${score}&url_f=&url_r=`,
                ),
            ),
        ]);

        const product = emptyProduct();
        product.id = itemCode;
        product.title = title;
        product.pricing = pricing;
        product.specifications = readSpecifications($);
        product.media = readMedia($, rsc);
        product.description = readDescription($);
        product.deliveryTimeText = deliveryTextFromShipping(shipping.data);
        product.paymentMethods = paymentLogos(payment.data);
        const stockLabel = $('span')
            .filter((_i, el) => /in stock/i.test($(el).text()))
            .first();
        product.stock.availableQuantity = availableQuantity(
            stockLabel.length > 0 ? stockLabel.text() : null,
            skuPrice.data,
        );
        product.stock.soldCount = parseCompactNumber($('[spm-index="freight"]').first().text());
        const rating = parseFloat($('#starLevel').first().text().trim());
        product.reviewsSummary.rating = Number.isFinite(rating) ? rating : null;
        product.reviewsSummary.reviewCount = parseAmount($('[spm-index="comment"]').first().text());
        stars.forEach((star, index) => {
            const data = star.data as { count?: number; data?: RawReview[] } | undefined;
            product.reviewsSummary.ratingBreakdown[String(index + 1) as '1'] = data?.count ?? 0;
            for (const item of (Array.isArray(data?.data) ? data.data : []).slice(0, REVIEWS_PER_STAR)) {
                const sample = mapReview(item);
                // The page gets these as webp; served to us, the same images come without it.
                sample.images = sample.images.map(asWebp);
                product.reviewsSummary.reviewSamples.push(sample);
            }
        });

        log.info(`[product] scraped over HTTP: ${title} (id=${itemCode})`, {
            htmlMs,
            apisMs: Date.now() - startedAt - htmlMs,
        });
        return { kind: 'product', product, sellerInline: readSellerInline($, rsc, loadedUrl), storeUrl };
    } catch (error) {
        return { kind: 'failed', reason: describeHttpError(error) };
    }
}

function isRefusalOrChallenge(html: string): boolean {
    return /<title>[^<]*(access denied|just a moment|attention required)/i.test(html) || html.includes('_cf_chl_opt');
}

/** GET one of the page's JSON APIs; throws unless it answered `state: 0x0000`. */
async function getJson(client: HttpClient, url: string): Promise<{ data: unknown }> {
    const response = await client.fetch(url, { headers: { accept: 'application/json, text/plain, */*' } });
    if (response.status !== 200) throw new Error(`HTTP ${response.status} from ${url.split('?')[0]}`);
    const json = (await response.json()) as { state?: string; data?: unknown };
    if (json.state !== '0x0000') throw new Error(`state ${json.state ?? '?'} from ${url.split('?')[0]}`);
    return { data: json.data };
}

/** The page's RSC flight data: every `self.__next_f.push([1,"…"])` string, unescaped and joined. */
export function readFlightData(html: string): string {
    const parts: string[] = [];
    for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
        parts.push(JSON.parse(match[1]) as string);
    }
    return parts.join('');
}

function firstNumber(rsc: string, key: string): number | null {
    const match = new RegExp(`"${key}":(-?[\\d.]+)`).exec(rsc);
    return match ? Number(match[1]) : null;
}

function firstString(rsc: string, key: string): string | null {
    return new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(rsc)?.[1] ?? null;
}

/**
 * What the buy box shows as the price — it is client-rendered, so it is rebuilt from its data:
 * - a new-buyer price (`showNewBuyerPrice`): that one price, `dealMaxMinBuyerPrice`;
 * - a promotion: `dealMinBuyerPrice` – `dealMaxBuyerPrice`.
 * Anything else has not been seen next to the browser's reading, so it gives `null` (the caller then
 * leaves the product to the browser).
 */
export function pricingFromFlightData(rsc: string): Pricing | null {
    if (rsc.includes('"showNewBuyerPrice":true')) {
        const price = firstNumber(rsc, 'dealMaxMinBuyerPrice');
        return price == null ? null : { currency: 'USD', priceMin: price, priceMax: price };
    }
    const min = firstNumber(rsc, 'dealMinBuyerPrice');
    const max = firstNumber(rsc, 'dealMaxBuyerPrice');
    if (min == null || max == null || min > max) return null;
    return { currency: 'USD', priceMin: min, priceMax: max };
}

/**
 * The "N in stock" label as the browser path reads it. The server renders it with the real number
 * (seen: "9999 in stock" where `pcskuprice.do` said a promotion limit of 1, "83" where it said an
 * inventory of 17 — the browser reported 9999 and 83), so the label wins. Only its "0" placeholder,
 * which the page fills in once the SKU data loads, is replaced by the API's figure. No label, no
 * figure — as on the browser path.
 */
export function availableQuantity(label: string | null, skuPrice: unknown): number | null {
    if (label == null) return null;
    const shown = parseCompactNumber(label);
    return shown || (availableQuantityFromSkuPrice(skuPrice) ?? shown);
}

/** The SKU's stock from `pcskuprice.do`: the promotion's purchase limit or the inventory, the lower. */
export function availableQuantityFromSkuPrice(data: unknown): number | null {
    const { promoLimitNum, inventoryNum } = (data ?? {}) as { promoLimitNum?: unknown; inventoryNum?: unknown };
    const limits = [promoLimitNum, inventoryNum].filter((n): n is number => typeof n === 'number');
    return limits.length > 0 ? Math.min(...limits) : null;
}

/** The buy box's delivery line: "N Days Delivery" when DHGate promises one, otherwise the date range. */
export function deliveryTextFromShipping(data: unknown): string | null {
    const route = (Array.isArray(data) ? data[0] : null) as {
        promiseDeliveryType?: number;
        promiseDelivery?: number;
        lowerDate?: string;
        upperDate?: string;
    } | null;
    if (!route) return null;
    if (route.promiseDeliveryType === 1 && route.promiseDelivery) return `${route.promiseDelivery} Days Delivery`;
    if (!route.lowerDate || !route.upperDate) return route.lowerDate ?? route.upperDate ?? null;
    return route.lowerDate === route.upperDate ? route.lowerDate : `${route.lowerDate} - ${route.upperDate}`;
}

function paymentLogos(data: unknown): string[] {
    const list = ((data ?? {}) as { paymentList?: { logo?: string }[] }).paymentList ?? [];
    const urls: string[] = [];
    for (const { logo } of list) if (logo && !urls.includes(logo)) urls.push(logo);
    return urls;
}

/** Review images: the browser's API answers with `…/webp/m/0x0/…`, impit's with the plain path. */
export function asWebp(url: string): string {
    return url.replace(/^(https:\/\/image\.dhgate\.com\/)(?!webp\/)/, '$1webp/m/0x0/');
}

function text($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
    return $(el).text().replace(/\s+/g, ' ').trim();
}

/** The h1's own text nodes — the badges inside it ("Buyers' Picks") are elements — as `extractTitle`. */
function readTitle($: CheerioAPI): string | null {
    const h1 = $('[data-section="SectionProductTitle"] h1, h1[itemprop="name"]').first();
    if (h1.length === 0) return null;
    const own = h1
        .contents()
        .filter((_i, node) => node.type === 'text')
        .text()
        .trim();
    return own || text($, h1) || null;
}

function readSpecifications($: CheerioAPI): Specification[] {
    const dl = $('[data-section="SectionProductSpecifications"] dl').first();
    const dts = dl.find('dt').toArray();
    const dds = dl.find('dd').toArray();
    const specs: Specification[] = [];
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
        const name = $(dts[i]).text().replace(/:\s*$/, '').trim();
        if (name) specs.push({ name, value: text($, dds[i]) });
    }
    return specs;
}

/** Gallery images as `extractMedia` reads them; the video, which the page only mounts on hover, from its data. */
function readMedia($: CheerioAPI, rsc: string): Media {
    const media: Media = { images: [], videos: [] };
    $('ul[spm-c="imagelist"] img').each((_i, el) => {
        const raw = $(el).attr('src') ?? $(el).attr('data-src');
        if (!raw) return;
        const url = toFullSize(raw);
        if (!media.images.some((image) => image.url === url)) media.images.push({ url });
    });
    const videoUrl = firstString(rsc, 'videoUrl');
    // The <video> the browser reads carries the first gallery image as its poster.
    if (videoUrl) media.videos.push({ url: videoUrl, poster: media.images[0]?.url ?? null });
    return media;
}

/** The description block as `extractDescription` reads it: its HTML, and its text line by line. */
function readDescription($: CheerioAPI): Description {
    const toggle = $('[spm-c="seeall_discription"], [spm-c="seeless_discription"]').first();
    const content = toggle
        .parent()
        .children('div')
        .filter((_i, el) => el !== toggle.get(0))
        .first();
    if (content.length === 0) return { html: '', plainText: '' };
    return { html: (content.html() ?? '').trim(), plainText: blockText($, content) };
}

/** `innerText` without a layout engine: block elements and <br> end lines; lines trimmed, blank ones dropped. */
function blockText($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
    const clone = $(el).clone();
    clone.find('br').replaceWith('\n');
    clone.find('p, div, li, tr, h1, h2, h3, h4, h5, h6, table, ul, ol, section').each((_i, block) => {
        $(block).append('\n');
    });
    return clone
        .text()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
}

/** The store link in the store header at the top of the page, on the `www` host, without query / hash. */
function readStoreUrl($: CheerioAPI, pageUrl: string): string | null {
    const href = $('a[spm-index="store"][href*="/store/"]').first().attr('href');
    if (!href) return null;
    const absolute = new URL(href, pageUrl);
    return normalizeDhgateHost(`${absolute.origin}${absolute.pathname}`);
}

/**
 * The seller as the product page's "About the Store" block would give it. The block is client-rendered;
 * its data is the store header link and the RSC supplier record. Its badges are not: their texts come
 * from DHGate's scripts, so they are left empty and the store page's fill in.
 */
function readSellerInline($: CheerioAPI, rsc: string, pageUrl: string): SellerInline | null {
    const link = $('[spm-c="logostore"] a[spm-index="store"]').first();
    const href = link.attr('href');
    if (!href) return null;
    const url = stripUrlParams(new URL(href, pageUrl).href);
    return {
        ref: {
            platformSellerId: extractSellerId(url),
            name: text($, link.find('b').first()) || link.attr('title')?.trim() || null,
            url,
        },
        positiveFeedbackPercent: parseAmount(firstString(rsc, 'showpercentum')),
        avatarUrl: normalizeImageUrl(firstString(rsc, 'sheadImg')),
        badges: [],
    };
}
