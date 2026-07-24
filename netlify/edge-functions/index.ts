/**
 * yoto-feed-cleaner (Netlify Edge Function) — v3, buffer-then-serve
 * ---------------------------------------------------------------------
 * v2 fully proxied audio live (upstream -> client, streamed). That may
 * still have been getting cut short around 45s into playback — possibly
 * NPO's CDN truncating "unrecognized" live connections, possibly
 * something about the long-lived streaming connection itself. v3 removes
 * that variable entirely: on first request for an episode, we download
 * the ENTIRE file server-side into memory, cache the raw bytes (+
 * content-type) in Netlify Blobs, and serve every request — this one and
 * all future ones, including Range requests — directly from that cached
 * copy. Yoto now always talks to a fully-buffered, locally-served file
 * with no live upstream connection involved in the response path at all.
 *
 * Trade-off: the first request for each episode has to wait for the full
 * download to complete before any bytes go back to Yoto (no time-to-
 * first-byte streaming head start). For typical podcast-episode file
 * sizes this should still land well within Netlify's 40-second
 * response-header timeout, but very large files could be a problem —
 * see MAX_BUFFER_BYTES below.
 *
 * File location: wherever your `config.path` routes already point
 * (e.g. repo-root/index.ts per your current setup, or
 * netlify/edge-functions/<name>.ts).
 *
 * Dependency: @netlify/blobs. If "npm:@netlify/blobs" doesn't resolve in
 * your Netlify build, try "https://esm.sh/@netlify/blobs" instead.
 *
 * Usage:
 *   Feed:  https://<your-site>.netlify.app/yoto-feed-cleaner?feed=<url-encoded feed>
 *   Debug: same, with &debug=1
 */

import { getStore } from "https://esm.sh/@netlify/blobs";

const FEED_CACHE_TTL_SECONDS = 60 * 60;
const FEED_FETCH_TIMEOUT_MS = 8000;
const AUDIO_FETCH_TIMEOUT_MS = 35000; // must comfortably clear Netlify's 40s header timeout
const MAX_BUFFER_BYTES = 150 * 1024 * 1024; // ~150MB safety cap; refuse to buffer anything larger
const URL_STORE_NAME = "yoto-feed-cleaner-urls";
const AUDIO_STORE_NAME = "yoto-feed-cleaner-audio";

const UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Referer": "https://podcast.npo.nl/",
  "Origin": "https://podcast.npo.nl",
  "Accept": "audio/mpeg, audio/*;q=0.9, */*;q=0.8",
};

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
  const urlStore = getStore({ name: URL_STORE_NAME, consistency: "strong" });

  const idFor = new Map<string, string>();
  await Promise.all(
    [...originalUrls].map(async (original) => {
      const id = await shortId(original);
      idFor.set(original, id);
      await urlStore.set(id, original);
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
  const urlStore = getStore({ name: URL_STORE_NAME, consistency: "strong" });

  const sample = await Promise.all(
    originalUrls.slice(0, 5).map(async (original) => {
      const id = await shortId(original);
      await urlStore.set(id, original);
      const proxyUrl = `${origin}/a/${id}`;
      const entry: Record<string, unknown> = { original, id, proxyUrl };
      try {
        const resolved = await fetchWithTimeout(
          original,
          { method: "GET", redirect: "follow", headers: { ...UPSTREAM_HEADERS, Range: "bytes=0-0" } },
          FEED_FETCH_TIMEOUT_MS
        );
        entry.resolvedStatus = resolved.status;
        entry.resolvedFinalUrl = resolved.url;
        entry.resolvedContentType = resolved.headers.get("content-type");
        entry.resolvedContentLength = resolved.headers.get("content-length");
        entry.resolvedContentRange = resolved.headers.get("content-range");
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

  const audioStore = getStore({ name: AUDIO_STORE_NAME, consistency: "strong" });

  // Already cached? Serve straight from Blobs — no upstream involved.
  const cachedMeta = await audioStore.getMetadata(id).catch(() => null);
  if (cachedMeta) {
    const bytes = await audioStore.get(id, { type: "arrayBuffer" });
    if (bytes) {
      return serveBuffer(bytes as ArrayBuffer, cachedMeta.metadata?.contentType as string | undefined, request);
    }
  }

  // Not cached yet — resolve the real URL, download the FULL file, cache it.
  const urlStore = getStore({ name: URL_STORE_NAME, consistency: "strong" });
  const target = await urlStore.get(id);
  if (!target) {
    return new Response(
      "Unknown episode id (feed may not have been fetched recently) — request the feed URL again first.",
      { status: 404 }
    );
  }

  let upstream: Response;
  try {
    // Deliberately no Range header here — we always want the whole file
    // on this first fetch, regardless of what Yoto's request asked for.
    upstream = await fetchWithTimeout(
      target,
      { method: "GET", redirect: "follow", headers: UPSTREAM_HEADERS },
      AUDIO_FETCH_TIMEOUT_MS
    );
  } catch (err) {
    return new Response(
      `Failed to fetch upstream audio: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    return new Response(`Upstream audio fetch failed: ${upstream.status}`, { status: 502 });
  }

  const declaredLength = Number(upstream.headers.get("content-length") ?? "0");
  if (declaredLength && declaredLength > MAX_BUFFER_BYTES) {
    return new Response(
      `Upstream file too large to buffer (${declaredLength} bytes > ${MAX_BUFFER_BYTES} limit)`,
      { status: 502 }
    );
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await upstream.arrayBuffer();
  } catch (err) {
    return new Response(
      `Failed reading upstream audio body: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 }
    );
  }

  if (buffer.byteLength > MAX_BUFFER_BYTES) {
    return new Response(
      `Downloaded file too large to cache (${buffer.byteLength} bytes > ${MAX_BUFFER_BYTES} limit)`,
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";

  // Cache for next time (including any Range sub-requests Yoto makes).
  await audioStore.set(id, buffer, { metadata: { contentType } });

  return serveBuffer(buffer, contentType, request);
}

function serveBuffer(buffer: ArrayBuffer, contentType: string | undefined, request: Request): Response {
  const total = buffer.byteLength;
  const rangeHeader = request.headers.get("range");
  const headers = new Headers({
    "content-type": contentType ?? "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
  });

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (match) {
      const start = match[1] === "" ? 0 : parseInt(match[1], 10);
      const end = match[2] === "" ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
      if (start <= end && start < total) {
        const slice = buffer.slice(start, end + 1);
        headers.set("content-range", `bytes ${start}-${end}/${total}`);
        headers.set("content-length", String(slice.byteLength));
        return new Response(slice, { status: 206, headers });
      }
      headers.set("content-range", `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }
  }

  headers.set("content-length", String(total));
  return new Response(buffer, { status: 200, headers });
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
  return hex;
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
