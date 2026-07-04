# OTM Docs API

Crawls the Oracle Transportation Management (OTM) 26B online help
(`docs.oracle.com/.../26b/otmol/`), turns it into JSON, and serves it from
your own Netlify site as a small searchable API. A scheduled GitHub Action
re-runs the crawl periodically so the data stays current.

## How it works

```
GitHub Action (cron)  --runs-->  scripts/scrape.js
                                       |
                                       v
                              Netlify Blobs store "otm-docs"
                                       |
                                       v
                     netlify/functions/docs-api.js  --serves-->  /api/docs
```

The scraper is a plain HTTP crawler (no headless browser needed — the
individual `.htm` topic pages are static HTML). It starts at the book's
`index.html`, follows in-scope links (`Related Topics`, in-body links),
and stores each page's title + cleaned text in Netlify Blobs.

The Netlify Function reads that blob on each request — no re-scraping
happens on the request path, so the API stays fast.

## 1. One-time setup

```bash
npm install
```

### Create/connect a Netlify site

```bash
npx netlify-cli login
npx netlify-cli init      # or: netlify link, if the site already exists
```

Grab two values you'll need as secrets:

- **Site ID**: `netlify status` (or Site settings → General → Site details)
- **Personal access token**: Netlify dashboard → User settings → Applications
  → New access token

### Add GitHub repo secrets

In your GitHub repo: Settings → Secrets and variables → Actions → New repository secret

- `NETLIFY_SITE_ID`
- `NETLIFY_AUTH_TOKEN`

## 2. First scrape (populate the data before the API has anything to serve)

Locally:

```bash
NETLIFY_SITE_ID=xxxx NETLIFY_AUTH_TOKEN=xxxx npm run scrape
```

This takes a while for a full crawl (potentially 1000+ pages — the script
is deliberately polite, ~4 concurrent requests with small delays, so it
does NOT hammer Oracle's servers). Progress prints to the console. A local
`otm-docs.json` copy is also written for your own inspection.

To do a quick smoke test first without hitting Netlify:

```bash
SKIP_BLOBS=1 npm run scrape:test    # crawls only 25 pages, writes local JSON only
```

Or trigger it from GitHub instead: Actions tab → "Scrape OTM Docs" →
Run workflow.

## 3. Deploy the site

```bash
npx netlify-cli deploy --prod
```

This publishes `public/` and the function in `netlify/functions/docs-api.js`.

## 4. Use the API

```
GET https://<your-site>.netlify.app/api/docs
GET https://<your-site>.netlify.app/api/docs?page=2&pageSize=50
GET https://<your-site>.netlify.app/api/docs?q=agent+action
GET https://<your-site>.netlify.app/api/docs?url=https://docs.oracle.com/en/cloud/saas/transportation/26b/otmol/...
```

## Auto-updating

`.github/workflows/scrape.yml` runs every Sunday at 03:00 UTC by default
and re-populates the Blobs store — no redeploy needed, since the Function
reads the store fresh on every request. Change the cron expression to
whatever cadence you want.

## Tuning knobs (env vars for scripts/scrape.js)

| Var | Default | Purpose |
|---|---|---|
| `BASE_URL` | 26B OTMOL index | Change to crawl a different book/release |
| `MAX_PAGES` | 3000 | Safety cap so a bug can't crawl forever |
| `CONCURRENCY` | 4 | Parallel requests |
| `REQUEST_DELAY_MS` | 200 | Pause between request batches |
| `SKIP_BLOBS` | unset | Set to `1` to skip the Netlify upload (local testing) |

## Notes / things worth knowing

- **Scope**: the crawler only follows links starting with `BASE_URL`, so it
  stays inside the OTM 26B OTMOL book and won't wander off into unrelated
  Oracle documentation.
- **Respectful crawling**: default concurrency/delay settings are
  intentionally conservative. If Oracle's site starts returning errors,
  lower `CONCURRENCY` further or raise `REQUEST_DELAY_MS`.
- **Release version**: this points at `26b`. When Oracle ships a new
  release (26C, etc.), update `BASE_URL` accordingly.
- **This is for personal/internal use.** Oracle's documentation is
  copyrighted; treat this mirror as a private reference tool rather than
  something you republish or expose publicly.
