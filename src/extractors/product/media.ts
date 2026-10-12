import type { Page } from 'playwright';
import type { Media } from '../../dto/index.js';

/**
 * DHGate serves the same image at different sizes via a `/<w>x<h>/` path segment
 * (e.g. `/webp/m/100x100/...`). The gallery thumbnails are 100x100; `/0x0/` returns
 * the original full-size image.
 */
function toFullSize(url: string): string {
    return url.replace(/\/\d+x\d+\//, '/0x0/');
}

/**
 * Extract product media URLs (gallery images + video).
 *
 * Images live in the thumbnail list `ul[spm-c="imagelist"]` (the `spm-c` tracking
 * attribute is a stable anchor; the surrounding classes are hashed). The product
 * video, when present, is NOT in the DOM initially — its thumbnail carries a
 * play-icon <i> and `event-type="mouseenter"`, and the <video> element only mounts
 * in the main display after that thumbnail is hovered. URLs are taken as-is.
 */
export async function extractMedia(page: Page): Promise<Media> {
    const media: Media = { images: [], videos: [] };

    const imgLoc = page.locator('ul[spm-c="imagelist"] img');
    await imgLoc
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 })
        .catch(() => {});

    const seenImg = new Set<string>();
    for (const el of await imgLoc.all()) {
        const raw = (await el.getAttribute('src')) ?? (await el.getAttribute('data-src'));
        if (!raw) continue;
        const url = toFullSize(raw); // thumbnail -> full-size original
        if (seenImg.has(url)) continue;
        seenImg.add(url);
        media.images.push({ url });
    }

    // The video thumbnail is the only gallery <li> with a play-icon <i>. Hovering
    // it mounts the <video>; plain image thumbnails have no <i>.
    const videoThumb = page.locator('ul[spm-c="imagelist"] li:has(i)').first();
    if ((await videoThumb.count()) > 0) {
        await videoThumb.hover({ timeout: 5_000 }).catch(() => {});
        await page
            .locator('video')
            .first()
            .waitFor({ state: 'attached', timeout: 5_000 })
            .catch(() => {});
    }

    const seenVid = new Set<string>();
    for (const el of await page.locator('video').all()) {
        const url = await el.getAttribute('src');
        // Only keep product videos hosted on DHGate's media CDNs.
        if (!url || seenVid.has(url) || !/dhimgs|dhresource|\.mp4/i.test(url)) continue;
        seenVid.add(url);
        const poster = await el.getAttribute('poster');
        media.videos.push({ url, poster: poster ?? null });
    }

    return media;
}
