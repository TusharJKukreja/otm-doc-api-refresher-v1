/**
 * OTM Documentation Scraper (Puppeteer-based)
 * ---------------------------------------------------------------------------
 * The Oracle OTM online help pages render their body content and navigation
 * links via client-side JavaScript, even on individual topic pages (a plain
 * HTTP fetch only returns an empty shell). So this scraper uses a real
 * headless browser to load each page, wait for it to render, then reads the
 * rendered DOM for title/content/links.
 *
 * Run standalone (e.g. from a GitHub Action - needs a full VM, not a
 * constrained serverless function, since launching a browser per page for
 * 1000+ pages takes real time and resources):
 *
 *   NETLIFY_SITE_ID=xxx NETLIFY_AUTH_TOKEN=xxx node scripts/scrape.js
 *
 * Env vars:
 *   BASE_URL         - book root to crawl (default: 26B OTMOL online help)
 *   MAX_PAGES        - safety cap on number of pages to visit (default 3000)
 *   CONCURRENCY      - parallel browser tabs (default 3 - be polite)
 *   REQUEST_DELAY_MS - delay between request batches in ms (default 300)
 *   PAGE_TIMEOUT_MS  - per-page navigation timeout (default 30000)
 *   OUTPUT_FILE      - local JSON path to also write results to
 *   NETLIFY_SITE_ID / NETLIFY_AUTH_TOKEN - required to push to Netlify Blobs
 *   SKIP_BLOBS=1     - skip the Netlify Blobs upload (useful for local testing)
 */

const puppeteer = require("puppeteer");
const pLimit = require("p-limit");
const fs = require("fs");
const path = require("path");

const BASE_URL =
  process.env.BASE_URL ||
  "https://docs.oracle.com/en/cloud/saas/transportation/26b/otmol/";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "3000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "300", 10);
const PAGE_TIMEOUT_MS = parseInt(process.env.PAGE_TIMEOUT_MS || "30000", 10);
const OUTPUT_FILE =
  process.env.OUTPUT_FILE || path.join(__dirname, "..", "otm-docs.json");

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OTM-Docs-Mirror-Bot/1.0";

const BOILERPLATE_PATTERNS = [
  /If you have any questions or comments about this topic.*?contact us\.?/gis,
  /Other Documentation Resources[\s\S]*?Report an issue in the help or guides.*/gis,
  /Copyright ©.*?Oracle and\/or its affiliates\./gis,
  /Was this page helpful\? Click to send feedback\./gi,
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.searchParams.delete("tocid");
    return u.toString();
  } catch {
    return null;
  }
}

function isInScope(url) {
  return typeof url === "string" && url.startsWith(BASE_URL) && /\.html?$/i.test(url);
}

async function scrapeOnePage(browser, url, attempt = 1) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: PAGE_TIMEOUT_MS,
    });

    await page.waitForSelector("body", { timeout: 5000 }).catch(() => {});
    await sleep(500);

    const extracted = await page.evaluate(() => {
      const title =
        document.querySelector("h1")?.innerText?.trim() ||
        document.title?.trim() ||
        "";
      const text = document.body ? document.body.innerText : "";
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.href)
        .filter(Boolean);
      return { title, text, links };
    });

    return extracted;
  } catch (err) {
    if (attempt < 2) {
      await sleep(1000);
      await page.close().catch(() => {});
      return scrapeOnePage(browser, url, attempt + 1);
    }
    console.warn(`  ! failed to render ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

function cleanContent(rawText) {
  let content = rawText.replace(/\s+/g, " ").trim();
  for (const pattern of BOILERPLATE_PATTERNS) {
    content = content.replace(pattern, " ");
  }
  return content.replace(/\s+/g, " ").trim();
}

async function crawl() {
  const seed = normalizeUrl(BASE_URL + "index.html");
  const queue = [seed];
  const visited = new Set();
  const pages = {};
  const limit = pLimit(CONCURRENCY);

  console.log(`Starting crawl at ${seed}`);
  console.log(`Scope prefix: ${BASE_URL}`);
  console.log(`Max pages: ${MAX_PAGES}, concurrency: ${CONCURRENCY}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    while (queue.length > 0 && visited.size < MAX_PAGES) {
      const batch = queue.splice(0, CONCURRENCY * 2).filter((u) => !visited.has(u));
      if (batch.length === 0) continue;

      await Promise.all(
        batch.map((url) =>
          limit(async () => {
            if (visited.has(url) || visited.size >= MAX_PAGES) return;
            visited.add(url);

            const extracted = await scrapeOnePage(browser, url);
            if (!extracted) return;

            const content = cleanContent(extracted.text);
            pages[url] = {
              title: extracted.title || url,
              content,
              wordCount: content.split(/\s+/).filter(Boolean).length,
            };

            console.log(`  [${visited.size}] ${pages[url].title} (${url})`);

            for (const rawLink of extracted.links) {
              const normalized = normalizeUrl(rawLink);
              if (
                normalized &&
                isInScope(normalized) &&
                !visited.has(normalized) &&
                !queue.includes(normalized)
              ) {
                queue.push(normalized);
              }
            }
          })
        )
      );

      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  return pages;
}

async function pushToNetlifyBlobs(dataset) {
  if (process.env.SKIP_BLOBS === "1") {
    console.log("SKIP_BLOBS=1 set, skipping Netlify Blobs upload.");
    return;
  }

  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;

  if (!siteID || !token) {
    console.warn(
      "NETLIFY_SITE_ID / NETLIFY_AUTH_TOKEN not set - skipping Blobs upload. " +
        "(Set SKIP_BLOBS=1 to silence this warning during local testing.)"
    );
    return;
  }

  const { getStore } = require("@netlify/blobs");
  const store = getStore({ name: "otm-docs", siteID, token });

  await store.setJSON("dataset", dataset);
  console.log("Uploaded dataset to Netlify Blobs store 'otm-docs' under key 'dataset'.");
}

async function main() {
  const startedAt = new Date().toISOString();
  const pages = await crawl();

  const dataset = {
    updatedAt: new Date().toISOString(),
    startedAt,
    sourceBase: BASE_URL,
    pageCount: Object.keys(pages).length,
    pages,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(dataset, null, 2));
  console.log(
    `\nWrote ${dataset.pageCount} pages to ${OUTPUT_FILE} (${(
      fs.statSync(OUTPUT_FILE).size /
      1024 /
      1024
    ).toFixed(2)} MB)`
  );

  if (dataset.pageCount <= 1) {
    console.warn(
      "\nWARNING: only found 1 page. This usually means the site's nav " +
        "links weren't rendered in time, or the page structure changed. " +
        "Check the selectors in scrapeOnePage() / crawl()."
    );
  }

  await pushToNetlifyBlobs(dataset);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error during scrape:", err);
  process.exit(1);
});
