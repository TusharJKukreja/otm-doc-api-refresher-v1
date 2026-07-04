/**
 * OTM Documentation Scraper
 * ---------------------------------------------------------------------------
 * Crawls the Oracle Transportation Management (OTM) online help pages under
 * a given book prefix, extracts title + body text + related links from each
 * static .htm/.html page, and writes the result to Netlify Blobs so the
 * Netlify Function (netlify/functions/docs-api.js) can serve it.
 *
 * Run standalone (e.g. from a GitHub Action):
 *   NETLIFY_SITE_ID=xxx NETLIFY_AUTH_TOKEN=xxx node scripts/scrape.js
 *
 * Useful env vars:
 *   BASE_URL        - book root to crawl (default: 26B OTMOL online help)
 *   MAX_PAGES       - safety cap on number of pages to visit (default 3000)
 *   CONCURRENCY     - parallel requests (default 4 - be polite to Oracle's servers)
 *   REQUEST_DELAY_MS- delay between request batches in ms (default 200)
 *   OUTPUT_FILE     - local JSON path to also write results to (default ./otm-docs.json)
 *   NETLIFY_SITE_ID / NETLIFY_AUTH_TOKEN - required to push to Netlify Blobs
 *   SKIP_BLOBS=1    - skip the Netlify Blobs upload (useful for local testing)
 */

const fetch = require("node-fetch");
const cheerio = require("cheerio");
const pLimit = require("p-limit");
const fs = require("fs");
const path = require("path");

const BASE_URL =
  process.env.BASE_URL ||
  "https://docs.oracle.com/en/cloud/saas/transportation/26b/otmol/";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "3000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "4", 10);
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "200", 10);
const OUTPUT_FILE =
  process.env.OUTPUT_FILE || path.join(__dirname, "..", "otm-docs.json");

const USER_AGENT =
  "OTM-Docs-Mirror-Bot/1.0 (+personal documentation indexing tool)";

// Boilerplate footer/nav text fragments to strip out of every page's content.
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
    // Strip tracking-ish / anchor params that don't change content
    u.searchParams.delete("tocid");
    return u.toString();
  } catch {
    return null;
  }
}

function isInScope(url) {
  return typeof url === "string" && url.startsWith(BASE_URL) && /\.html?$/i.test(url);
}

async function fetchPage(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 20000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt < 3) {
      await sleep(500 * attempt);
      return fetchPage(url, attempt + 1);
    }
    console.warn(`  ! failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

function extractPage(url, html) {
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() || $("title").first().text().trim() || url;

  // Remove script/style/nav/footer-ish elements before grabbing text
  $("script, style, nav, header, footer").remove();

  let content = $("body").text().replace(/\s+/g, " ").trim();
  for (const pattern of BOILERPLATE_PATTERNS) {
    content = content.replace(pattern, " ");
  }
  content = content.replace(/\s+/g, " ").trim();

  const links = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let absolute;
    try {
      absolute = new URL(href, url).toString();
    } catch {
      return;
    }
    const normalized = normalizeUrl(absolute);
    if (normalized && isInScope(normalized)) {
      links.add(normalized);
    }
  });

  return { url, title, content, links: Array.from(links) };
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

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const batch = queue.splice(0, CONCURRENCY * 2).filter((u) => !visited.has(u));
    if (batch.length === 0) continue;

    await Promise.all(
      batch.map((url) =>
        limit(async () => {
          if (visited.has(url) || visited.size >= MAX_PAGES) return;
          visited.add(url);

          const html = await fetchPage(url);
          if (!html) return;

          const page = extractPage(url, html);
          pages[url] = {
            title: page.title,
            content: page.content,
            wordCount: page.content.split(/\s+/).filter(Boolean).length,
          };

          console.log(`  [${visited.size}] ${page.title} (${url})`);

          for (const link of page.links) {
            if (!visited.has(link) && !queue.includes(link)) {
              queue.push(link);
            }
          }
        })
      )
    );

    await sleep(REQUEST_DELAY_MS);
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

  await pushToNetlifyBlobs(dataset);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error during scrape:", err);
  process.exit(1);
});
