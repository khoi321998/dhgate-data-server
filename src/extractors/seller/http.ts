import type { Log } from '@crawlee/playwright';
import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';

import type {
    Seller,
    SellerAbout,
    SellerReviewScore,
    SellerServiceScore,
    SellerServiceScoreItem,
} from '../../dto/index.js';
import { emptySeller } from '../../utils/defaults.js';
import type { HttpClient } from '../../utils/http.js';
import { describeHttpError } from '../../utils/http.js';
import {
    extractSellerId,
    normalizeImageUrl,
    parseAmount,
    parseCompactNumber,
    stripUrlParams,
} from '../../utils/parse.js';
import { LABEL_TO_KEY } from './about.js';
import type { RawReviewCard } from './feedback.js';
import { MAX_REVIEWS_PER_TYPE, parseIndustry, REVIEW_TYPES, reviewSamplesFromCards } from './feedback.js';
import type { RawPreviewCard } from './products.js';
import { previewsFromCards } from './products.js';

/** The seller, or why the HTTP path gave up — then the caller loads the store page in a tab instead. */
export type StoreHttpResult = { kind: 'seller'; seller: Seller } | { kind: 'failed'; reason: string };

/**
 * Scrape the store over plain HTTP — top-selling page, About Us, and the Review page with its three
 * filters — instead of rendering them in browser tabs. These are DHGate's legacy, server-rendered
 * store pages: all the data is in the HTML, so a request costs ~0.3 s and no CPU, where a tab runs
 * the page's scripts. Requests go through impit, which presents Chrome's TLS / HTTP2 fingerprint:
 * DHGate's Akamai answers a plain Node client with 403 "Access Denied".
 *
 * The HTML is read with the selectors the browser extractors use, and the seller is assembled the
 * way `scrapeStorePage` assembles it, so both paths give the same row. Anything unexpected — a
 * refusal, a challenge, a page that is not a store page, a missing review form — fails the whole
 * HTTP path rather than returning part of a seller: the caller then loads the store in a tab, which
 * handles challenges, not-found stores and slow pages.
 */
export async function scrapeStoreOverHttp(storeUrl: string, client: HttpClient, log: Log): Promise<StoreHttpResult> {
    const startedAt = Date.now();
    try {
        const store = await getPage(client, storeUrl);
        const $ = load(store.html);
        // The same test as `detectNotFound` for a seller: no store header, no store. The tab path
        // reports that properly (SELLER_NOT_FOUND), so it gets the call.
        if ($('.store-head-warp, .storeinfo, .storelogo').length === 0) {
            return { kind: 'failed', reason: 'no store header in the HTML' };
        }

        const previews = previewsFromCards(readPreviewCards($));
        const header = readHeader($);
        const reviewHref = $('a[spm-c="oncreview"][href*="seller-feedback"]').first().attr('href');
        const aboutHref = $('a[spm-c="oncabout"]').first().attr('href');
        const reviewUrl = reviewHref ? stripUrlParams(new URL(reviewHref, store.url).href) : null;
        const aboutUrl = aboutHref ? stripUrlParams(new URL(aboutHref, store.url).href) : null;
        if (!reviewUrl) return { kind: 'failed', reason: 'no Review link on the store page' };

        // About Us and the Review page do not depend on each other; the review filters need the Review page's form.
        const [about, review] = await Promise.all([
            aboutUrl ? getPage(client, aboutUrl).then((page) => readAbout(load(page.html))) : Promise.resolve(null),
            getPage(client, reviewUrl),
        ]);
        const $review = load(review.html);
        const stats = readFeedbackStats($review);
        const reviewScore = readReviewScore($review);
        const serviceScore = readServiceScore($review);
        const buckets = await readReviewBuckets(client, $review, review.url);
        if (typeof buckets === 'string') return { kind: 'failed', reason: buckets };

        const seller = emptySeller();
        seller.url = store.url;
        seller.productPreviews = previews;
        seller.name = header.name;
        seller.platformSellerId = extractSellerId(store.url);
        seller.avatarUrl = header.avatarUrl;
        seller.badges = header.badges;
        seller.positiveFeedbackPercent = header.positiveFeedbackPercent ?? stats.positiveFeedbackPercent;
        seller.transactions = header.transactions ?? stats.transactions;
        if (about) seller.about = about;
        if (reviewScore) seller.reviewScore = reviewScore;
        if (serviceScore) seller.serviceScore = serviceScore;
        seller.positiveReviewSamples = buckets.positive;
        seller.neutralReviewSamples = buckets.neutral;
        seller.negativeReviewSamples = buckets.negative;

        log.info(`[seller] store scraped over HTTP in ${Date.now() - startedAt}ms`, {
            previews: previews.length,
            about: about != null,
            reviews: {
                positive: buckets.positive.length,
                neutral: buckets.neutral.length,
                negative: buckets.negative.length,
            },
        });
        return { kind: 'seller', seller };
    } catch (error) {
        return { kind: 'failed', reason: describeHttpError(error) };
    }
}

/** GET a page; throws on a refusal or a challenge, so the caller falls back to the browser. */
async function getPage(client: HttpClient, url: string): Promise<{ url: string; html: string }> {
    // A request the proxy drops is already sent once more by the client (see `createHttpClient`).
    const response = await client.fetch(url);
    const html = await response.text();
    if (response.status >= 400) throw new Error(`HTTP ${response.status} for ${url}`);
    if (/<title>[^<]*(access denied|just a moment|attention required)/i.test(html) || html.includes('_cf_chl_opt')) {
        throw new Error(`refused or challenged at ${url}`);
    }
    return { url: response.url || url, html };
}

function text($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
    return $(el).text().replace(/\s+/g, ' ').trim();
}

/** `#proGallery .gitem` cards — the fields `extractSellerProducts` reads in the browser. */
function readPreviewCards($: CheerioAPI): RawPreviewCard[] {
    return $('#proGallery .gitem')
        .toArray()
        .map((item) => {
            const card = $(item);
            const pic = card.find('a.pic').first();
            const title = card.find('a.pro-title').first();
            return {
                itemcode: pic.attr('itemcode') ?? null,
                href: pic.attr('href') ?? null,
                imageSrc: card.find('img.gthumbnail').first().attr('src') ?? null,
                titleAttr: title.attr('title') ?? null,
                titleText: text($, title),
                priceText: text($, card.find('li.price span').first()),
                originalPriceText: text($, card.find('li.costprice span').first()),
                ratingStyle: card.find('.pro-rating .rating > span').first().attr('style') ?? null,
                reviewText: text($, card.find('.pro-rating .num').first()),
            };
        });
}

/** The store header — as `extractSellerHeader` reads it. */
function readHeader($: CheerioAPI) {
    const nameEl = $('.sto-name').first();
    const name = text($, nameEl) || nameEl.attr('title') || null;
    const badges: string[] = [];
    $('.seller-identification span[title]').each((_i, el) => {
        const title = $(el).attr('title')?.trim();
        if (title && !badges.includes(title)) badges.push(title);
    });
    return {
        name: name?.trim() || null,
        avatarUrl: normalizeImageUrl($('.storelogo img').first().attr('src') ?? null),
        badges,
        positiveFeedbackPercent: parseAmount(text($, $('a[spm-c="positive feedback"]').first())),
        transactions: parseCompactNumber(text($, $('a[spm-c="Transactions"]').first())),
    };
}

/** The About Us page — as `extractSellerAboutAt` reads it. */
function readAbout($: CheerioAPI): SellerAbout | null {
    const about: SellerAbout = {};
    const introduction = text($, $('#StoreContent + .aboutcon dd h2').first()) || null;
    if (introduction) about.introduction = introduction;
    $('#BasicContent + .aboutcon')
        .first()
        .find('dl')
        .each((_i, row) => {
            const label = text($, $(row).find('dt').first()).replace(/:\s*$/, '').toLowerCase();
            const value = text($, $(row).find('dd').first());
            const key = LABEL_TO_KEY[label];
            if (key && value) about[key] = value;
        });
    return Object.keys(about).length > 0 ? about : null;
}

/** The Review page's feedback header — as `extractFeedbackStats` reads it. */
function readFeedbackStats($: CheerioAPI): { positiveFeedbackPercent: number | null; transactions: number | null } {
    let positiveFeedbackPercent: number | null = null;
    let transactions: number | null = null;
    $('.seller-information-warp .feedback-info li').each((_i, li) => {
        const label = text($, $(li).find('span').first());
        const value = text($, $(li).find('strong').first());
        if (/positive/i.test(label)) positiveFeedbackPercent ??= parseAmount(value);
        else if (/transaction/i.test(label)) transactions ??= parseCompactNumber(value);
    });
    return { positiveFeedbackPercent, transactions };
}

/** The `.review-score` table's Total column — as `extractReviewScore` reads it. */
function readReviewScore($: CheerioAPI): SellerReviewScore | null {
    const table = $('.review-score').first();
    if (table.length === 0) return null;
    const total = (marker: string) => {
        const cell = table.find(`tr:has(${marker}) td:last-child`).first();
        return cell.length === 0 ? null : parseCompactNumber(text($, cell));
    };
    const positive = total('.a1');
    const neutral = total('.a2');
    const negative = total('.a3');
    if (positive == null && neutral == null && negative == null) return null;
    return { positive, neutral, negative };
}

/** The "Service Detail Score" table — as `extractServiceScore` reads it. */
function readServiceScore($: CheerioAPI): SellerServiceScore | null {
    const block = $('.service-score').first();
    if (block.length === 0) return null;
    const industry = parseIndustry(text($, block.find('.bt .review-style').first()));
    const items: SellerServiceScoreItem[] = [];
    block.find('table.list tr').each((_i, el) => {
        const row = $(el);
        if (row.find('.jdt').length === 0) return;
        const cells = row.find('td');
        if (cells.length < 4) return;
        items.push({
            detail: text($, cells.eq(0)) || null,
            score: parseAmount(row.find('.jdt').first().attr('title') ?? null) ?? parseAmount(text($, cells.eq(1))),
            numberOfRatings: parseCompactNumber(text($, cells.eq(3))),
        });
    });
    return items.length === 0 ? null : { industry, items };
}

/** `.review-list-pro` cards — as `extractReviews` reads them. */
function readReviewCards($: CheerioAPI): RawReviewCard[] {
    return $('.review-list-pro')
        .toArray()
        .slice(0, MAX_REVIEWS_PER_TYPE)
        .map((el) => {
            const card = $(el);
            return {
                user: text($, card.find('.user-info p').first()),
                country: text($, card.find('.review-country .country').first()),
                ratingStyle: card.find('.review-list-rate b').first().attr('style') ?? null,
                reviewDate: text($, card.find('.review-list-time').first()),
                comment: text($, card.find('dd p').first()),
                helpful: text($, card.find('.review-text1').first()),
                unhelpful: text($, card.find('.review-text3').last()),
            };
        });
}

/**
 * The three review filters, from the URLs the page's `SellerscoreActionForm` (a GET form) would load:
 * its fields as the browser would submit them, with `score` set to the filter. All three at once: the
 * client keeps no cookie jar, so no session carries one filter over to the next. Each is still checked
 * by the `#score` it came back with, and asked once more when it is another (seen: Positive answered
 * as "All"). Returns why on failure.
 */
async function readReviewBuckets(
    client: HttpClient,
    $review: CheerioAPI,
    reviewUrl: string,
): Promise<Record<'positive' | 'neutral' | 'negative', ReturnType<typeof reviewSamplesFromCards>> | string> {
    const form = $review('form[name="SellerscoreActionForm"]').first();
    if (form.length === 0) return 'no review filter form on the Review page';
    const action = new URL(form.attr('action') ?? reviewUrl, reviewUrl).href;
    // What a GET submit sends: named controls in document order, minus buttons and unchecked boxes.
    const fields: [string, string][] = form
        .find('input[name], select[name], textarea[name]')
        .toArray()
        .filter((el) => {
            const type = ($review(el).attr('type') ?? '').toLowerCase();
            if (['button', 'submit', 'image', 'reset', 'file'].includes(type)) return false;
            if (type === 'checkbox' || type === 'radio') return $review(el).attr('checked') !== undefined;
            return true;
        })
        .map((el) => [$review(el).attr('name') ?? '', $review(el).val()?.toString() ?? '']);

    const filtered = await Promise.all(
        REVIEW_TYPES.map(async ({ type, status }) => {
            const query = new URLSearchParams(
                fields.map(([name, value]) => {
                    if (name === 'score') return [name, status];
                    if (name === 'page') return [name, '1'];
                    return [name, value];
                }),
            );
            let cards: RawReviewCard[] | null = null;
            for (let attempt = 0; attempt < 2 && !cards; attempt++) {
                const page = await getPage(client, `${action}?${query.toString()}`);
                const $ = load(page.html);
                if ($('#score').first().val()?.toString() === status) cards = readReviewCards($);
            }
            return { type, cards };
        }),
    );
    const result = { positive: [], neutral: [], negative: [] } as Record<
        'positive' | 'neutral' | 'negative',
        ReturnType<typeof reviewSamplesFromCards>
    >;
    for (const { type, cards } of filtered) {
        if (!cards) return `the ${type} review filter did not apply`;
        result[type] = reviewSamplesFromCards(cards);
    }
    return result;
}
