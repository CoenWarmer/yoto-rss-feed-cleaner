/**
 * yoto-feed-cleaner (Netlify Edge Function) — v2, full audio proxy
 * ------------------------------------------------------------------
 * v1 tried to resolve each enclosure's redirect chain and rewrite the
 * feed to point straight at the final URL. That failed for NPO's feed
 * because:
 *   1. The redirect only happens on GET, not HEAD, so v1's detection
 *      (HEAD-first) never even saw it.
 *   2. The actual redirect target isn't a short-lived tracking wrapper
 *      — it's a cross-domain redirect (podcast.npo.nl -> a
 *      *.cdn.streamgate.nl host) carrying a long opaque JWT directly in
 *      the URL path. Even if resolved correctly, handing Yoto that
 *      final URL still means it has to follow a redirect to an unusual,
 *      long, foreign-domain URL — plausibly the actual thing its
 *      embedded HTTP client chokes on, not the redirect hop count.
 *
 * v2 sidesteps the whole question of "what exactly is too complex for
 * Yoto's client" by making sure Yoto never sees the origin URL, the
 * redirect, or the CDN's JWT URL at all:
 *
 *   - The rewritten feed points each episode at a short path on THIS
 *     domain: /a/<12-char-hash>
 *   - Netlify Blobs stores the hash -> real original URL mapping
 *     (written whenever the feed itself is fetched/regenerated)
 *   - When Yoto requests /a/<hash>, this function looks up the real
 *     URL, does a normal GET with redirect:"follow" (fully resolving
 *     the npo.nl -> streamgate.nl hop server-side), and streams the
 *     resulting audio bytes straight back under a plain 200 response.
 *
 * Yoto only ever talks to one short, flat, single-hop URL on our own
 * domain — no redirects, no query strings, no foreign hosts.
 *
 * File location: netlify/edge-functions/yoto-feed-cleaner.ts (or
 * whatever filename — this one lives at repo-root/index.ts per your
 * current setup, matching the `config.path` values below regardless of
 * filename).
 *
 * Dependency: @netlify/blobs. If the "npm:@netlify/blobs" specifier
 * below doesn't resolve in your Netlify build, try
 * "https://esm.sh/@netlify/blobs" instead — Netlify's Deno-based Edge
 * Function runtime supports both import styles, but which one is
 * required has shifted with tooling versions, so worth checking Netlify's
 * current Edge Functions + npm imports docs if this errors on deploy.
 *
 * Usage:
 *   Feed:  https://<your-site>.netlify.app/yoto-feed-cleaner?feed=<url-encoded feed>
 *   Debug: same, with &debug=1
 */

import { getStore } from "npm:@netlify/blobs";

const FEED_CACHE_TTL_SECONDS = 60 * 60;
const FEED_FETCH_TIMEOUT_MS = 8000;
const AUDIO_FETCH_TIMEOUT_MS = 30000;
const STORE_NAME = "yoto-feed-cleaner-urls";

export const config = { path: ["/yoto-feed-cleaner", "/a/*"] };

export default async (request: Request): Promise<Response> => {
  const incoming = new URL(request.url);

  if (incoming.pathname.startsWith("/a/")) {
    return handleAudioProxy(incoming, request);
  }
  return handleFeed(incoming);
};

async function handleFeed(incoming: URL): Promise<Response> {
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

  const originResp = await fetchWithTimeout(
    originUrl.toString(),
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; YotoFeedCleaner/1.0)" } },
    FEED_FETCH_TIMEOUT_MS
  );
  if (!originResp.ok) {
    return new Response(`Upstream feed fetch failed: ${originResp.status}`, { status: 502 });
  }

  const xml = await originResp.text();

  if (incoming.searchParams.get("debug") === "1") {
    const report = await debugReport(xml, incoming.origin);
    return new Response(JSON.stringify(report, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const cleaned = await rewriteEnclosuresToProxy(xml, incoming.origin);

  return new Response(cleaned, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, s-maxage=${FEED_CACHE_TTL_SECONDS}, stale-while-revalidate=${FEED_CACHE_TTL_SECONDS}`,
    },
  });
}

async function rewriteEnclosuresToProxy(xml: string, origin: string): Promise<string> {
  const originalUrls = extractEnclosureUrls(xml);
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  const idFor = new Map<string, string>();
  await Promise.all(
    [...originalUrls].map(async (original) => {
      const id = await shortId(original);
      idFor.set(original, id);
      // Idempotent write — keeps the mapping fresh if an episode's
      // underlying URL ever changes, and cheap enough to do every time
      // the feed is fetched.
      await store.set(id, original);
    })
  );

  let out = xml;
  for (const [original, id] of idFor) {
    const encodedOriginal = encodeXmlEntities(original);
    const proxyUrl = `${origin}/a/${id}`;
    out = out.split(`url="${encodedOriginal}"`).join(`url="${proxyUrl}"`);
  }
  return out;
}

async function debugReport(xml: string, origin: string) {
  const originalUrls = [...extractEnclosureUrls(xml)];
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  const sample = await Promise.all(
    originalUrls.slice(0, 5).map(async (original) => {
      const id = await shortId(original);
      await store.set(id, original);
      const proxyUrl = `${origin}/a/${id}`;
      const entry: Record<string, unknown> = { original, id, proxyUrl, proxyUrlLength: proxyUrl.length };
      try {
        const resolved = await fetchWithTimeout(
          original,
          { method: "GET", redirect: "follow", headers: { Range: "bytes=0-0" } },
          FEED_FETCH_TIMEOUT_MS
        );
        entry.resolvedStatus = resolved.status;
        entry.resolvedFinalUrl = resolved.url;
        entry.resolvedContentType = resolved.headers.get("content-type");
      } catch (err) {
        entry.resolveError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      return entry;
    })
  );

  return { enclosureCount: originalUrls.length, sample };
}

async function handleAudioProxy(incoming: URL, request: Request): Promise<Response> {
  const id = incoming.pathname.replace(/^\/a\//, "");
  if (!id) return new Response("Missing id", { status: 400 });

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const target = await store.get(id);
  if (!target) {
    return new Response(
      "Unknown episode id (feed may not have been fetched recently) — request the feed URL again first.",
      { status: 404 }
    );
  }

  const forwardHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; YotoFeedCleaner/1.0)",
  };
  const range = request.headers.get("range");
  if (range) forwardHeaders["Range"] = range;

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      target,
      {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        redirect: "follow",
        headers: forwardHeaders,
      },
      AUDIO_FETCH_TIMEOUT_MS
    );
  } catch (err) {
    return new Response(
      `Failed to fetch upstream audio: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 }
    );
  }

  const respHeaders = new Headers();
  for (const h of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  respHeaders.set("cache-control", "public, max-age=86400");

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

function extractEnclosureUrls(xml: string): Set<string> {
  const enclosureRegex = /<enclosure\b[^>]*\burl="([^"]+)"[^>]*\/?>/g;
  const urls = new Set<string>();
  for (const m of xml.matchAll(enclosureRegex)) {
    urls.add(decodeXmlEntities(m[1]));
  }
  return urls;
}

async function shortId(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 6; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex; // 12 hex chars — short, stable per source URL
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FEED_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function encodeXmlEntities(s: string): string {
  return s.replace(/&/g, "&amp;");
}
