# DHGate Data Server

A self-hosted HTTP server that scrapes one DHGate product or seller URL per request and returns the row in the response: product (title, pricing, stock, delivery, payment methods, description, specifications, media, reviews) and/or seller (store header, product previews, about, feedback).

Pages are loaded in a headed real Google Chrome driven by [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) through Crawlee's `PlaywrightCrawler`, which waits out (or clicks through) DHGate's Cloudflare challenge. Each retry runs on a new session and so, through Apify Proxy (`APIFY_PROXY_GROUPS`: datacenter or residential), a new IP. Apify is used only for that proxy; this is not an Apify Actor.

Every request runs in a Chrome launched for it, on a new proxy session (so a new IP) with no cookies from earlier requests, and the browser is closed when the request is done. A failed attempt (blocked, Cloudflare it cannot pass, an error) is retried up to `MAX_REQUEST_RETRIES` times, each time in a new browser on a new session. `MAX_CONCURRENCY` requests run in parallel, the rest wait in the crawler's queue, and once `MAX_QUEUE` requests are running or waiting the server returns `503`.

## API

### `POST /scrape`

Scrapes one URL. Requires the `x-api-key` header.

```bash
curl -X POST http://localhost:8080/scrape \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{"url":"https://www.dhgate.com/product/limited-edition-writers-victor-hugo-ballpoint/1069501131.html","mode":"product_and_seller","transactionId":"order-1234"}'
```

| Field | Required | Description |
| --- | --- | --- |
| `url` | yes | A `dhgate.com` http(s) URL: a product page, or a store page for `seller_only`. Regional hosts (`es.`, `fr.`, ...) are crawled on `www` with that region as the ship-to country |
| `mode` | no | `product_only` (default), `product_and_seller` or `seller_only` |
| `transactionId` | no | Caller's id for this request, 1-100 letters, digits or `. _ : -`. Not returned in the response. Every log line of the request shows it next to the url (`https://... [transactionId: order-1234]`) |

Response `200`:

```json
{
    "status": "success",
    "platform": "dhgate",
    "url": "https://www.dhgate.com/product/...",
    "capturedAt": "2026-10-12T08:02:08.761Z",
    "captureMode": "product_and_seller",
    "actorRunId": null,
    "success": true,
    "errorCode": null,
    "errorMessage": null,
    "product": { "id": "1069501131", "title": "...", "pricing": {}, "stock": {}, "...": "..." },
    "sellerRef": { "platformSellerId": "...", "name": "...", "url": "..." },
    "seller": { "name": "...", "productPreviews": [], "...": "..." },
    "extraction": { "status": "ok", "checkedFields": 18, "missingFields": [] },
    "timing": { "queueMs": 188, "processMs": 31615, "totalMs": 31803 }
}
```

- The body is the same row the Apify Actor pushed to its dataset (see [src/dto/response.ts](src/dto/response.ts)), plus `status` and `timing`.
- A `200` can still have `success: false`: `errorCode` is `ITEM_NOT_FOUND` / `SELLER_NOT_FOUND` when the listing or store is gone, or `FETCH_FAILED` when the product was scraped but the seller page never loaded (the product is kept).
- `product_and_seller` reads the store link from the store header at the top of the product page and scrapes the store — top-selling page, About Us, the Review page and its three filters — while the product is being scraped. It does so over plain HTTP (impit, as the request's browser: its proxy, user agent and cookies), and only opens the pages in tabs of the request's browser when HTTP fails (`STORE_OVER_HTTP`). The request takes about as long as the product page. If the store cannot be scraped either way, the whole request is retried in a new browser; once retries run out the product is kept and the row reports `FETCH_FAILED` for the seller. The two rows are merged with the same precedence as before (identity from the product page, stats / previews / about / reviews from the store page).
- `extraction.status` other than `ok` usually means a DHGate markup change broke a selector.
- `timing.queueMs` is the time before the crawler picked the request up. `processMs` is the scrape itself, including retries.
- Every error response has the same body: `{ "status": "failed", "url", "error", "statusCode", "timing" }`. `url` is `null` when the request had no valid url. `statusCode` is the HTTP status of the last failed navigation, or `null`; `timing` is all zeros when no scrape ran.

| Status | Meaning |
| --- | --- |
| `200` | Scraped (check `success` / `errorCode`) |
| `400` | Body is not valid JSON, `url` is missing or not a dhgate.com http(s) URL, or `mode` / `transactionId` is invalid |
| `401` | Missing or wrong `x-api-key` |
| `502` | Scrape failed: no page could be loaded after all retries, or no result within `JOB_TIMEOUT_SECS` |
| `503` | Queue is full (`MAX_QUEUE`) |

### `GET /`

Health check. No auth. Returns `{"status":"ok","maxConcurrency":4,"maxQueue":100,"inProgress":1,"jobs":1,"browsers":{"active":1,"retired":0}}`.

## Running with Docker

Put the configuration in `.env` next to the Dockerfile (see [Configuration](#configuration)). `.env` is ignored by git and Docker, so secrets are never committed or baked into the image.

```bash
docker build -t dhgate-data-server .
docker run -d --name dhgate-server -p 8080:8080 --init --shm-size=1g --env-file .env dhgate-data-server
```

- Chrome runs headed (headless never clears DHGate's Cloudflare challenge), so the container needs a display (Xvfb, which the `apify/actor-node-playwright-chrome` base image ships).
- `--init` reaps exited Chrome processes so they don't pile up as zombies. `--shm-size=1g` gives Chrome more shared memory than Docker's 64 MB default.
- Bind the port to a private IP (or `127.0.0.1` behind Nginx / Caddy). Docker's port publishing bypasses `ufw`.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `API_KEY` | required | Shared secret the caller sends in `x-api-key` (at least 16 characters). Generate with `openssl rand -hex 32` |
| `PORT` | `8080` | HTTP port |
| `MAX_CONCURRENCY` | `4` | Requests scraped at once, each in its own headed Chrome (with up to 3 tabs for `product_and_seller`). Size it to the machine: under load each page gets slower and DHGate's lazy blocks start to miss their waits |
| `MAX_QUEUE` | `100` | Max requests running or waiting. Beyond this, requests get `503` |
| `MAX_REQUEST_RETRIES` | `3` | Retries per page after the first attempt, each on a new session / proxy IP |
| `JOB_TIMEOUT_SECS` | `900` | A request with no result after this long gets `502` |
| `PARALLEL_SELLER` | `true` | `product_and_seller`: start scraping the store as soon as the product page has loaded, instead of after the product is scraped. `false` = one after the other |
| `CRASH_GUARD` | `true` | Give the product page an empty init script. DHGate's Next.js page crashes into "Application error" on ~1 in 6 attempts without it, and did not crash once with it (40 vs 40 requests, interleaved). The crash is then retried, so turning this off costs time, not data. An injected script is a trace bot detection can look for — the reason it can be turned off |
| `PRODUCT_OVER_HTTP` | `true` | Scrape each request over plain HTTP first — the product page, the JSON APIs the page itself calls (SKU price, shipping, reviews, payment logos) and the store pages — with no browser at all. The request goes to the browser as before when that gives up (a refusal, a challenge, a price or page it cannot read). See [HTTP path](#http-path-no-browser). `false` = always a browser |
| `HTTP_MAX_RPS` | `5`, `0` with `RESIDENTIAL` | HTTP requests per second across the server, `0` = no limit. Akamai blocks an IP that asks too fast (~85/s) for ~10 minutes, browser included; through the residential proxy each request has its own IP |
| `HTTP_SESSION_RETRIES` | `3` | New proxy sessions (new IPs) the HTTP path tries when its session is refused — HTTP 403 / 429, Akamai's "Access Denied", a Cloudflare challenge, a connection dropped twice — before the request goes to the browser. A page it cannot read is not retried (a new IP gets the same page). Without a proxy there is no IP to change, so a block goes straight to the browser |
| `STORE_OVER_HTTP` | `true` | Scrape the store, About and Review pages over plain HTTP (impit, Chrome's TLS fingerprint) as the request's browser — its proxy, user agent and cookies — instead of in browser tabs; a tab is opened only when HTTP fails. `false` = always tabs |
| `DEBUG_PAGE_ERRORS` | `false` | Diagnosis only: record each page's JavaScript errors, failed requests and URL changes, and log them (`[crash debug]`) when DHGate's page crashes into "Application error". Injects a script into the page, which bot detection can notice — keep it off in production |
| `APIFY_PROXY_PASSWORD` | | Required when `APIFY_PROXY_GROUPS` is set; the server refuses to start without it |
| `APIFY_PROXY_GROUPS` | empty | Apify proxy: empty = none (this machine's own IP, many more Cloudflare challenges), `DATACENTER` or `RESIDENTIAL` (the exit that measured best on DHGate). Anything else stops the server at startup |
| `APIFY_PROXY_COUNTRY` | `US` | Two-letter exit country. Empty = any country |
| `DHGATE_CHALLENGE_TIMEOUT_MS` | `60000` | How long to let the Cloudflare challenge run (see [src/utils/cloudflare.ts](src/utils/cloudflare.ts)) |

The server logs its effective configuration at startup. Secrets are shown only as `set` or `not set`.

## Timeouts for callers

Measured over 20 sequential `product_and_seller` requests each (October 2026): ~7–9 s without a proxy, ~13–17 s (up to ~28 s) through Apify's residential US proxy. A blocked or crashed page is retried `MAX_REQUEST_RETRIES` times with a 5 s pause and a Cloudflare wait each, so a worst-case request takes several minutes. Set the caller's HTTP timeout above that (or above `JOB_TIMEOUT_SECS`).

## Logs

Every line of a request starts with its `transactionId` (`[transactionId: order-1234] | ...`), so one request can be found with `docker logs dhgate-server 2>&1 | grep order-1234`. The url is logged once, on the `Received` line; a request sent without a `transactionId` is prefixed with its url instead. The lines are `Received ...`, the crawl steps (`... | [product] title: ...`, `... | [seller] header ...`, Cloudflare and retry lines), and then `Scraped ...` or `Scrape failed for ...`. A full queue logs `Rejected ...: server busy`.

## HTTP path (no browser)

With `PRODUCT_OVER_HTTP` on (the default), a request is first scraped without a browser, in [src/http-path.ts](src/http-path.ts): the product page's HTML and the JSON APIs the page itself calls, and — for `product_and_seller` and `seller_only` — the store, About and Review pages. Requests go through impit (Chrome's TLS fingerprint; Akamai answers Node's own client with 403), on a proxy session of their own, with the locale cookies the browser path sets.

| Field | From |
| --- | --- |
| title, specifications, images, description, rating, review count, sold count, "N in stock", store link | the product page's HTML |
| price, video, default SKU, seller id / avatar / positive feedback | the page's RSC flight data (`self.__next_f.push(…)`) |
| stock, when the label is still its `0` placeholder | `pcskuprice.do` |
| delivery time | `ship.do` |
| rating breakdown, review samples | `pageReviewOfProd` (one call per star, in parallel) |
| payment logos | `getPaymentMethodIcons.do` |
| seller stats, previews, about, review samples | the store pages, as `STORE_OVER_HTTP` |

A refused session — HTTP 403 / 429, "Access Denied", a challenge, a connection dropped twice — is first retried on a new proxy session, a new IP, up to `HTTP_SESSION_RETRIES` times; each attempt is logged (`HTTP attempt N/M (session …)`, then `blocked … — retrying on a new session`), and the final line lists every attempt. It gives up — and the request goes to the browser exactly as before — on a refusal or challenge that outlasts those sessions, an HTTP error, a page without a title, a price shown in a way not checked against the browser, an API that fails twice, or a row missing a field no live page lacks (id, title, price, seller id / name — the audit's `broken`). A field a listing can genuinely lack (specifications, delivery, …) does not send it to the browser: the row is returned as the APIs gave it. A product that does not exist is an answer (`ITEM_NOT_FOUND`), not a reason to give up.

Compared with the browser path field by field (residential proxy, 8 products, `product_and_seller`): every request went over HTTP, in 5–11 s against 13–18 s, with the same row but for:

- `seller.badges`: the product page's "About the Store" badges are written by DHGate's scripts (the HTML and RSC only have codes like `sellerTieringLevel: LV4`), so the row has the store page's badges instead;
- `product.description.html`: the links lack the tracking parameters (`dspm`, `exposeflag`) DHGate's scripts add once the page runs;
- `product.stock.availableQuantity` can differ between any two visits, on either path: DHGate renders the label with the real stock on one visit and the new-buyer promotion limit (often `1`) on another.

## Troubleshooting

What has gone wrong so far, how it shows in the logs, and what to try. Grep one request's lines with its `transactionId`.

### Blocked by Akamai or Cloudflare — check our injected scripts first

DHGate is behind Akamai (cookies `ak_bmsc`, `bm_sz`, `_abck`) and Cloudflare (`__cf_bm`). **We inject a script into the product page**, and an injected script is exactly the kind of trace bot detection looks for:

- `CRASH_GUARD` (on by default) adds an empty init script — it is what keeps DHGate's page from crashing (see below);
- `DEBUG_PAGE_ERRORS=true` adds an error recorder, also an init script.

Patchright puts an init script in by routing the page's document through itself. None of this has been flagged so far (~140 requests with a script, direct and through the residential proxy, no challenge), but if blocks start, suspect it first.

| Signs | Try |
| --- | --- |
| `Cloudflare challenge … still up … going for the checkbox`, `Clicking the Cloudflare checkbox`, retries `Cloudflare is still holding us on its challenge page` | 1. Make sure `DEBUG_PAGE_ERRORS` is off. 2. Set `CRASH_GUARD=false` and compare the block rate. The crashes come back (~1 in 6 attempts), but they are retried, so that costs time, not data |
| `DHGate answered HTTP 403`, `DHGate served its "Access Denied" page` (Akamai) | Same as above, then look at the IP: with no proxy or `DATACENTER`, every request and every retry comes from one IP; switch to `RESIDENTIAL`. Lower `MAX_CONCURRENCY` if it happens under load |
| `HTTP path gave up after … (…) — scraping in a browser. Attempts: …` | Expected now and then (the request is then scraped as before, just slower). The parenthesis says why there was no further attempt (`still blocked after N sessions`, `not a block…`, `no proxy to change the IP`), `Attempts:` lists each one with its reason. If it is every request, the reasons say why: `HTTP 403` / `refused or challenged` = Akamai is refusing impit (with no proxy, check `HTTP_MAX_RPS`); `the price is shown in a way not checked against the browser` = DHGate changed its pricing data. `missing …` = the HTML lacks a critical field — DHGate changed its markup. `PRODUCT_OVER_HTTP=false` turns the path off |
| `[seller] store over HTTP gave up (refused or challenged at …)` | The store pages' HTTP client (impit) is being refused. Store data still comes through a browser tab; set `STORE_OVER_HTTP=false` to stop trying HTTP |

### DHGate's page crashes: "Application error: a client-side exception has occurred"

Log: `Attempt N failed … DHGate's page crashed in the browser (Next.js "Application error")`. DHGate's Next.js product page dies a few seconds after load (just before it: `specifications: count=0`, `deliveryTimeText: (none)`). It happens with and without a proxy: ~17% of attempts in a 40-request run without `CRASH_GUARD`, 0 with it (40 requests, interleaved). The JavaScript error itself was never captured — Patchright keeps the page's console closed, and the recorder that would show it (`DEBUG_PAGE_ERRORS`) is an init script, so it stops the crashes too.

- Check `"CRASH_GUARD":true` in the `Server config` line at startup.
- A crash is caught within ~1 s and the request retried in a new browser, so the row is still complete.

### Store pages always fall back to a tab

Log on every `product_and_seller` request: `[seller] store over HTTP failed (…)`.

- **In Docker:** impit's native binary is an optional dependency (`impit-linux-x64-gnu`). The Dockerfile must not run `npm install --omit=optional`, or impit throws `Cannot find native binding` and every store page goes to a tab — slower, two more tabs per request, and through the proxy the tabs can stall.
- Do not replace impit with `fetch` / axios: Akamai fingerprints the TLS / HTTP2 handshake and answers Node's client with 403 "Access Denied" on every DHGate page (curl and Postman get through; so does impit, which impersonates Chrome).

### Fields missing more often through the residential proxy

The residential exit drops some requests (`console error … ERR_TUNNEL_CONNECTION_FAILED`, `429`). Seen: `paymentMethods` empty (`[paymentMethods] no payment logos — Failed to fetch`), now and then `deliveryTimeText`. Without a proxy these did not occur. Compare `RESIDENTIAL`, `DATACENTER` and no proxy before changing code.

### Review samples: `switching the filter on the page instead`

The Review page's filters (Positive / Neutral / Negative) are fetched one after the other, because DHGate keeps the active filter in the session: requested in parallel, they came back with each other's filter. Each response is checked against the filter asked for and asked once more; this line means it still did not apply, and the slow path (switching the filter on the page) took over. Occasional is fine.

### Development pitfalls

- **`npm run start:prod` runs `dist/`**: run `npm run build` after every change, or you are testing the old code.
- **`__name is not defined` from `page.evaluate`**: under `tsx` (`start:dev`), esbuild wraps named functions in `__name(...)`, which the page does not have. Write page functions without named inner functions (see `extractors/seller/products.ts`). The `tsc` build is not affected. `utils/cloudflare.ts` still has named helpers in its click-position code, so that path fails under `start:dev` only.
- **The page's console is invisible**: Patchright does not open it. Only `Failed to load resource` lines reach `console error …`; for JavaScript errors use `DEBUG_PAGE_ERRORS=true` (`[crash debug]` lines on a crash).

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test
API_KEY=<key> npm run start:dev    # runs src/server.ts with tsx (needs Google Chrome installed locally)
```
