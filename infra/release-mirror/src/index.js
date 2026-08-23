const REPOSITORY = "Eynzof/Hermes-CN-Desktop";
export const MAX_ASSET_BYTES = 480 * 1024 * 1024;
const VERSION_TTL = 30 * 24 * 60 * 60;
const LATEST_TTL = 5 * 60;
const ASSET_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,254}$/;
const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}

export function parseMirrorRoute(pathname) {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  let tag;
  let asset;
  try {
    tag = decodeURIComponent(match[1]);
    asset = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if ((tag !== "latest" && !VERSION_TAG.test(tag)) || !ASSET_NAME.test(asset)) return null;
  if (match[1].includes("%2f") || match[1].includes("%2F") || match[2].includes("%")) return null;
  return { tag, asset, immutable: tag !== "latest" };
}

export function githubAssetUrl(route) {
  const tag = route.tag === "latest" ? "latest/download" : `download/${route.tag}`;
  return `https://github.com/${REPOSITORY}/releases/${tag}/${encodeURIComponent(route.asset)}`;
}

function upstreamHeaders() {
  return new Headers({
    accept: "application/octet-stream",
    "user-agent": "Hermes-CN-Desktop-Cloudflare-Mirror/1",
  });
}

export function responseSize(headers) {
  const range = headers.get("content-range");
  const rangeMatch = range?.match(/\/([0-9]+)$/);
  if (rangeMatch) return Number(rangeMatch[1]);
  const length = headers.get("content-length");
  return length ? Number(length) : null;
}

function mirroredResponse(upstream, route) {
  const headers = new Headers(upstream.headers);
  const ttl = route.immutable ? VERSION_TTL : LATEST_TTL;
  if (upstream.ok) {
    headers.set(
      "cache-control",
      route.immutable
        ? `public, max-age=${ttl}, s-maxage=${ttl}, immutable`
        : `public, max-age=60, s-maxage=${ttl}`,
    );
  } else if (upstream.status === 404) {
    headers.set("cache-control", "public, max-age=0, s-maxage=60");
  } else {
    headers.set("cache-control", "no-store");
  }
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "Content-Length, Content-Range, ETag, Accept-Ranges, CF-Cache-Status, X-Mirror-Upstream");
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-mirror-upstream", "github");
  headers.delete("set-cookie");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function originFetch(route, method) {
  const ttl = route.immutable ? VERSION_TTL : LATEST_TTL;
  return fetch(githubAssetUrl(route), {
    method,
    // Workers Caching strips an inbound Range header, asks this Worker for a
    // complete 200 response, then serves the requested slice as a cacheable
    // 206. Never ask GitHub for a partial object here.
    headers: upstreamHeaders(),
    redirect: "follow",
    cf: {
      cacheEverything: true,
      cacheTtl: ttl,
      cacheTtlByStatus: {
        "200-299": ttl,
        "404": 60,
        "500-599": 0,
      },
    },
  });
}

function enforceSize(upstream) {
  const size = responseSize(upstream.headers);
  if (!Number.isFinite(size)) {
    return json({ error: "GitHub asset has no trustworthy content length" }, 502);
  }
  if (Number.isFinite(size) && size > MAX_ASSET_BYTES) {
    upstream.body?.cancel();
    return json({ error: "asset exceeds 480 MiB updater gate" }, 413);
  }
  return null;
}

async function proxyAsset(request, route) {
  if (request.method === "HEAD") {
    const upstream = await originFetch(route, "HEAD");
    if (upstream.ok) {
      const rejected = enforceSize(upstream);
      if (rejected) return rejected;
    }
    return mirroredResponse(upstream, route);
  }

  // Gate the final GitHub object before streaming it. Workers Caching invokes
  // this path only on a miss; cached objects bypass the Worker entirely.
  const head = await originFetch(route, "HEAD");
  if (!head.ok) return mirroredResponse(head, route);
  const rejected = enforceSize(head);
  if (rejected) return rejected;

  const upstream = await originFetch(route, "GET");
  if (upstream.ok) {
    const downloadRejected = enforceSize(upstream);
    if (downloadRejected) return downloadRejected;
  }
  return mirroredResponse(upstream, route);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        environment: env.ENVIRONMENT,
        service: "hermes-desktop-release-mirror",
        upstream: "github-release",
        storage: "none",
      });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "Range, If-None-Match, If-Modified-Since",
          "access-control-max-age": "86400",
        },
      });
    }
    if (!new Set(["GET", "HEAD"]).has(request.method)) return json({ error: "not found" }, 404);
    const route = parseMirrorRoute(url.pathname);
    if (!route) return json({ error: "not found" }, 404);
    return proxyAsset(request, route);
  },
};
