/**
 * yoto-feed-cleaner (Netlify Edge Function)
 * ------------------------------------------
 * Same purpose as the Cloudflare Worker version: proxies a podcast RSS
 * feed and rewrites <enclosure url="..."> values to their final,
 * fully-resolved URL, stripping analytics/ad-insertion redirect
 * wrappers (Triton Digital, Podtrac, etc) that Yoto's embedded player
 * can choke on.
 *
 * Netlify Edge Functions run on Deno, which — like Cloudflare Workers —
 * implements standard fetch/Request/Response/AbortController, so the
 * core logic below is unchanged from the Workers version. The only
 * differences are the export shape (a plain default function instead of
 * a { fetch } object) and how caching is expressed: instead of the
 * Workers-specific `caches.default` API, we just set a `Cache-Control`
 * header with `s-maxage`, which Netlify's CDN respects for Edge
 * Function responses.
 *
 * File location matters: this must live at
 *   netlify/edge-functions/index.ts
 * The `config` export below registers its path automatically — no
 * netlify.toml edits required.
 *
 * Usage once deployed:
 *   https://<your-site>.netlify.app/yoto-feed-cleaner?feed=<url-encoded original feed url>
 *
 * Add that URL as the RSS source on a Yoto "Make Your Own" podcast card
 * instead of the original feed URL.
 *
 * Deploy:
 *   npm install -g netlify-cli
 *   netlify login
 *   # from your site's root, with this file at netlify/edge-functions/index.ts
 *   netlify deploy --prod
 */

const CACHE_TTL_SECONDS = 60 * 60; // ask Netlify's CDN to cache the rewritten feed for an hour
const FETCH_TIMEOUT_MS = 8000;

export default async (request: Request): Promise<Response> => {
  const incoming = new URL(request.url);
  const feedParam = incoming.searchParams.get("feed");

  if (!feedParam) {
    return new Response(
      "Usage: /yoto-feed-cleaner?feed=<url-encoded podcast RSS feed URL>",
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  let originUrl: URL;
  try {
    originUrl = new URL(feedParam);
  } catch {
    return new Response("Invalid feed URL", { status: 400 });
  }
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") {
    return new Response("Only http/https feed URLs are supported", { status: 400 });
  }

  const originResp = await fetchWithTimeout(originUrl.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; YotoFeedCleaner/1.0)" },
  });
  if (!originResp.ok) {
    return new Response(`Upstream feed fetch failed: ${originResp.status}`, { status: 502 });
  }

  const xml = await originResp.text();
  const cleaned = await rewriteEnclosures(xml);

  return new Response(cleaned, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      // s-maxage tells Netlify's shared CDN cache to hold this; browsers
      // (and Yoto's backend) will still see a fresh copy each interval.
      "cache-control": `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS}`,
    },
  });
};

export const config = { path: "/yoto-feed-cleaner" };

async function rewriteEnclosures(xml: string): Promise<string> {
  const enclosureRegex = /<enclosure\b[^>]*\burl="([^"]+)"[^>]*\/?>/g;
  const originalUrls = new Set<string>();
  for (const m of xml.matchAll(enclosureRegex)) {
    originalUrls.add(decodeXmlEntities(m[1]));
  }

  const resolved = new Map<string, string>();
  await Promise.all(
    [...originalUrls].map(async (original) => {
      try {
        resolved.set(original, await resolveFinalUrl(original));
      } catch {
        // If resolution fails for any reason, keep the original URL rather
        // than breaking the whole feed.
        resolved.set(original, original);
      }
    })
  );

  let out = xml;
  for (const [original, final] of resolved) {
    if (final === original) continue;
    const encodedOriginal = encodeXmlEntities(original);
    const encodedFinal = encodeXmlEntities(final);
    out = out.split(`url="${encodedOriginal}"`).join(`url="${encodedFinal}"`);
  }
  return out;
}

async function resolveFinalUrl(url: string): Promise<string> {
  // Prefer HEAD (cheap, no body transfer). Some CDNs/redirectors reject
  // HEAD, so fall back to a ranged GET which also avoids downloading the
  // full audio file just to find out where it ends up.
  let resp = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" });
  if (!resp.ok && resp.status !== 405) {
    resp = await fetchWithTimeout(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
    });
  }
  return resp.url || url;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&#39;":
        return "'";
      default:
        return entity;
    }
  });
}

function encodeXmlEntities(s: string): string {
  return s.replace(/&/g, "&amp;");
}