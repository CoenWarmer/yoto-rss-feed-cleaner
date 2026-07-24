/**
 * yoto-feed-cleaner (Netlify Edge Function) — v4, pre-cache on feed fetch
 * ------------------------------------------------------------------------
 * v3 buffered-and-cached each episode on its first *play* request. v4
 * additionally kicks off background downloads for every episode in the
 * feed as soon as the FEED itself is fetched (i.e. whenever Yoto polls
 * the RSS URL), using context.waitUntil so it doesn't delay the feed
 * response. By the time you actually press play, most/all episodes
 * should already be sitting in Netlify Blobs — no first-play download
 * delay, no live upstream connection involved at playback time at all.
 *
 * Design notes:
 *   - Already-cached episodes are skipped quickly (a metadata check),
 *     so repeat feed polls stay cheap — only genuinely new episodes
 *     trigger a download.
 *   - Downloads run with limited concurrency (PRECACHE_CONCURRENCY) to
 *     keep memory use bounded, since Edge Functions share a 512MB memory
 *     budget and buffering many multi-MB files at once adds up fast.
 *   - Background work via waitUntil is best-effort: if it gets cut off
 *     partway (long feeds, many new episodes at once), whatever wasn't
 *     cached yet just falls back to the normal on-demand download the
 *     first time it's actually played — nothing breaks, it just isn't
 *     pre-warmed. Netlify's docs don't give a hard number for how long
 *     background waitUntil work is allowed to run, so treat this as
 *     "helps a lot, not guaranteed to finish for very long feeds."
 *
 * File location: wherever your `config.path` routes already point.
 * Dependency: @netlify/blobs (see import line below re: esm.sh fallback).
 *
 * Usage:
 *   Feed:  https://<your-site>.netlify.app/yoto-feed-cleaner?feed=<url-encoded feed>
 *   Debug: same, with &debug=1
 */

import { getStore } from "https://esm.sh/@netlify/blobs";
import type { Context } from "https://edge.netlify.com";

const FEED_CACHE_TTL_SECONDS = 60 * 60;
const FEED_FETCH_TIMEOUT_MS = 8000;
const AUDIO_FETCH_TIMEOUT_MS = 35000; // must comfortably clear Netlify's 40s header timeout
const MAX_BUFFER_BYTES = 150 * 1024 * 1024; // ~150MB safety cap per episode
const PRECACHE_CONCURRENCY = 3; // how many episodes to download in parallel during pre-cache
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

export default async (request: Request, context: Context): Promise<Response> => {
  const incoming = new URL(request.url);

  if (incoming.pathname.startsWith("/a/")) {
    return handleAudioProxy(incoming, request);
  }
  return handleFeed(incoming, context);
};

async function handleFeed(incoming: URL, context: Context): Promise<Response> {
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

  const originalUrls = extractEnclosureUrls(xml);
  const idFor = new Map<string, string>();
  const urlStore = getStore({ name: URL_STORE_NAME, consistency: "strong" });
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
    out = out.split(`url="${encodedOriginal}"`).join(`url="${incoming.origin}/a/${id}"`);
  }

  // Kick off background pre-caching for every episode, without delaying
  // this response. Already-cached episodes are skipped fast.
  context.waitUntil(precacheAll(idFor));

  return new Response(out, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, s-maxage=${FEED_CACHE_TTL_SECONDS}, stale-while-revalidate=${FEED_CACHE_TTL_SECONDS}`,
    },
  });
}

async function precacheAll(idFor: Map<string, string>): Promise<void> {
  const audioStore = getStore({ name: AUDIO_STORE_NAME, consistency: "strong" });
  const entries = [...idFor.entries()]; // [original, id][]

  // Simple bounded-concurrency worker pool.
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const [original, id] = entries[cursor++];
      try {
        const alreadyCached = await audioStore.getMetadata(id).catch(() => null);
        if (alreadyCached) continue;
        await cacheEpisode(id, original, audioStore);
      } catch {
        // Best-effort — a failed pre-cache just means this episode falls
        // back to on-demand download the first time it's actually played.
      }
    }
  }
  await Promise.all(Array.from({ length: PRECACHE_CONCURRENCY }, () => worker()));
}

/** Downloads the full episode and stores it in Blobs. Shared by pre-cache and on-demand paths. */
async function cacheEpisode(
  id: string,
  target: string,
  audioStore: ReturnType<typeof getStore>
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const upstream = await fetchWithTimeout(
    target,
    { method: "GET", redirect: "follow", headers: UPSTREAM_HEADERS },
    AUDIO_FETCH_TIMEOUT_MS
  );
  if (!upstream.ok) {
    throw new Error(`Upstream audio fetch failed: ${upstream.status}`);
  }

  const declaredLength = Number(upstream.headers.get("content-length") ?? "0");
  if (declaredLength && declaredLength > MAX_BUFFER_BYTES) {
    throw new Error(`Upstream file too large to buffer (${declaredLength} bytes)`);
  }

  const buffer = await upstream.arrayBuffer();
  if (buffer.byteLength > MAX_BUFFER_BYTES) {
    throw new Error(`Downloaded file too large to cache (${buffer.byteLength} bytes)`);
  }

  const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
  await audioStore.set(id, buffer, { metadata: { contentType } });
  return { buffer, contentType };
}

async function debugReport(xml: string, origin: string) {
  const originalUrls = [...extractEnclosureUrls(xml)];
  const urlStore = getStore({ name: URL_STORE_NAME, consistency: "strong" });
  const audioStore = getStore({ name: AUDIO_STORE_NAME, consistency: "strong" });

  const sample = await Promise.all(
    originalUrls.map(async (original) => {
      const id = await shortId(original);
      await urlStore.set(id, original);
      const cached = await audioStore.getMetadata(id).catch(() => null);
      return {
        original,
        id,
        proxyUrl: `${origin}/a/${id}`,
        cached: Boolean(cached),
        cachedContentType: cached?.metadata?.contentType ?? null,
      };
    })
  );

  return {
    enclosureCount: originalUrls.length,
    cachedCount: sample.filter((s) => s.cached).length,
    episodes: sample,
  };
}

async function handleAudioProxy(incoming: URL, request: Request): Promise<Response> {
  const id = incoming.pathname.replace(/^\/a\//, "");
  if (!id) return new Response("Missing id", { status: 400 });

  const audioStore = getStore({ name: AUDIO_STORE_NAME, consistency: "strong" });

  const cachedMeta = await audioStore.getMetadata(id).catch(() => null);
  if (cachedMeta) {
    const bytes = await audioStore.get(id, { type: "arrayBuffer" });
    if (bytes) {
      return serveBuffer(bytes as ArrayBuffer, cachedMeta.metadata?.contentType as string | undefined, request);
    }
  }

  // Not cached yet (pre-cache hasn't gotten to it, or this is a brand new
  // episode) — download now, on demand, same as v3 did.
  const urlStore = getStore({ name: URL_STORE_NAME, consistency: "strong" });
  const target = await urlStore.get(id);
  if (!target) {
    return new Response(
      "Unknown episode id (feed may not have been fetched recently) — request the feed URL again first.",
      { status: 404 }
    );
  }

  let result: { buffer: ArrayBuffer; contentType: string };
  try {
    result = await cacheEpisode(id, target, audioStore);
  } catch (err) {
    return new Response(
      `Failed to fetch/cache upstream audio: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 }
    );
  }

  return serveBuffer(result.buffer, result.contentType, request);
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

