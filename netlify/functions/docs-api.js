/**
 * GET /.netlify/functions/docs-api
 *   -> paginated full dump: { updatedAt, pageCount, page, pageSize, totalPages, results: [...] }
 *
 * GET /.netlify/functions/docs-api?q=agent+action
 *   -> search across title + content: { query, matchCount, results: [...] }
 *
 * GET /.netlify/functions/docs-api?url=<full page url>
 *   -> single page's full content
 *
 * Query params:
 *   page      (default 1)
 *   pageSize  (default 50, max 200)
 */

const { getStore } = require("@netlify/blobs");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const SNIPPET_RADIUS = 160;

function buildSnippet(content, query) {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(content.length, idx + query.length + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const store =
      siteID && token
        ? getStore({ name: "otm-docs", siteID, token })
        : getStore("otm-docs");
    const dataset = await store.get("dataset", { type: "json" });

    if (!dataset) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error:
            "No dataset available yet. Run the scraper (npm run scrape) at least once to populate it.",
        }),
      };
    }

    const params = event.queryStringParameters || {};
    const pages = dataset.pages || {};

    // --- Single page lookup ---
    if (params.url) {
      const page = pages[params.url];
      if (!page) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "URL not found in dataset", url: params.url }),
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ url: params.url, updatedAt: dataset.updatedAt, ...page }),
      };
    }

    // --- Search mode ---
    if (params.q) {
      const query = params.q.trim();
      const results = Object.entries(pages)
        .filter(
          ([, page]) =>
            page.title.toLowerCase().includes(query.toLowerCase()) ||
            page.content.toLowerCase().includes(query.toLowerCase())
        )
        .map(([url, page]) => ({
          url,
          title: page.title,
          snippet: buildSnippet(page.content, query),
        }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          query,
          updatedAt: dataset.updatedAt,
          matchCount: results.length,
          results,
        }),
      };
    }

    // --- Full paginated dump ---
    const pageNum = Math.max(1, parseInt(params.page || "1", 10));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(params.pageSize || String(DEFAULT_PAGE_SIZE), 10))
    );

    const entries = Object.entries(pages);
    const totalPages = Math.ceil(entries.length / pageSize) || 1;
    const start = (pageNum - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize).map(([url, page]) => ({
      url,
      title: page.title,
      content: page.content,
      wordCount: page.wordCount,
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        updatedAt: dataset.updatedAt,
        pageCount: entries.length,
        page: pageNum,
        pageSize,
        totalPages,
        results: slice,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
