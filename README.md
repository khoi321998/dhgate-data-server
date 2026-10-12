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
- `product_and_seller` reads the store link from the store header at the top of the product page and opens the store page in a second tab of the request's browser while the product is being scraped (and the store's About Us page in a third), so the request takes about as long as the slower of the two pages. If the store page is blocked or fails, the whole request is retried in a new browser; once retries run out the product is kept and the row reports `FETCH_FAILED` for the seller. The two rows are merged with the same precedence as before (identity from the product page, stats / previews / about / reviews from the store page).
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
| `PARALLEL_SELLER` | `true` | `product_and_seller`: open the store page in a second tab as soon as the product page has loaded, instead of after the product is scraped. `false` = one after the other |
| `APIFY_PROXY_PASSWORD` | | Required when `APIFY_PROXY_GROUPS` is set; the server refuses to start without it |
| `APIFY_PROXY_GROUPS` | empty | Apify proxy: empty = none (this machine's own IP, many more Cloudflare challenges), `DATACENTER` or `RESIDENTIAL` (the exit that measured best on DHGate). Anything else stops the server at startup |
| `APIFY_PROXY_COUNTRY` | `US` | Two-letter exit country. Empty = any country |
| `DHGATE_CHALLENGE_TIMEOUT_MS` | `60000` | How long to let the Cloudflare challenge run (see [src/utils/cloudflare.ts](src/utils/cloudflare.ts)) |

The server logs its effective configuration at startup. Secrets are shown only as `set` or `not set`.

## Timeouts for callers

A product page takes ~10 s, `product_and_seller` ~30 s. A blocked page is retried `MAX_REQUEST_RETRIES` times with a 5 s pause and a Cloudflare wait each, so a worst-case request takes several minutes. Set the caller's HTTP timeout above that (or above `JOB_TIMEOUT_SECS`).

## Logs

Every line of a request starts with its url and `transactionId`, so one request can be found with `docker logs dhgate-server 2>&1 | grep order-1234`. The lines are `Received ...`, the crawl steps (`... | [product] title: ...`, `... | [seller] header ...`, Cloudflare and retry lines), and then `Scraped ...` or `Scrape failed for ...`. A full queue logs `Rejected ...: server busy`.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test
API_KEY=<key> npm run start:dev    # runs src/server.ts with tsx (needs Google Chrome installed locally)
```
