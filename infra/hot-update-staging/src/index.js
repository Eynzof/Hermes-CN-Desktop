const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function noContent() {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseSemver(value) {
  const match = String(value)
    .trim()
    .replace(/^[vV]/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right);
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`invalid semver comparison: ${left} / ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const compared = compareIdentifier(a.prerelease[index], b.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export async function rolloutBucket(deviceId, releaseId) {
  const hash = await sha256Hex(`${deviceId}:${releaseId}`);
  return Number.parseInt(hash.slice(0, 8), 16) % 100;
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function authenticate(request, env, ctx) {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const device = await env.UPDATES.prepare(
    "SELECT id, ring, status, last_seen_at FROM devices WHERE token_sha256 = ?1 LIMIT 1",
  )
    .bind(tokenHash)
    .first();
  if (!device || device.status !== "active") return null;

  const lastSeen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 60 * 60 * 1000) {
    ctx.waitUntil(
      env.UPDATES.prepare(
        "UPDATE devices SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
      )
        .bind(device.id)
        .run(),
    );
  }
  return device;
}

function checkRoute(pathname) {
  const match = pathname.match(/^\/v1\/check\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return {
    target: decodeURIComponent(match[1]),
    arch: decodeURIComponent(match[2]),
    currentVersion: decodeURIComponent(match[3]),
  };
}

async function releaseForDevice(env, device, target, arch) {
  const release = await env.UPDATES.prepare(
    `SELECT * FROM releases
       WHERE channel = ?1 AND target = ?2 AND arch = ?3 AND status = 'published'
       ORDER BY sequence DESC
       LIMIT 1`,
  )
    .bind(device.ring, target, arch)
    .first();
  if (!release || release.rollout_percent <= 0) return null;
  const bucket = await rolloutBucket(device.id, release.id);
  return bucket < release.rollout_percent ? release : null;
}

function updaterResponse(request, release) {
  const origin = new URL(request.url).origin;
  const artifactUrl = `${origin}/v1/artifacts/${encodeURIComponent(release.id)}/${encodeURIComponent(release.file_name)}`;
  return {
    version: release.version,
    pub_date: release.pub_date,
    url: artifactUrl,
    signature: release.signature,
    notes: release.notes,
    metadata: {
      releaseId: release.id,
      channel: release.channel,
      bundledCoreVersion: release.bundled_core_version,
      bundledRuntimeVersion: release.bundled_runtime_version,
      runtimeRevision: release.runtime_revision,
    },
  };
}

async function handleCheck(request, env, device, route) {
  const release = await releaseForDevice(env, device, route.target, route.arch);
  if (!release) return noContent();
  try {
    if (compareSemver(release.version, route.currentVersion) <= 0) return noContent();
  } catch {
    return json({ error: "invalid current_version" }, 400);
  }
  return json(updaterResponse(request, release));
}

function artifactRoute(pathname) {
  const match = pathname.match(/^\/v1\/artifacts\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return {
    releaseId: decodeURIComponent(match[1]),
    fileName: decodeURIComponent(match[2]),
  };
}

async function authorizedRelease(env, device, route) {
  const release = await env.UPDATES.prepare(
    `SELECT * FROM releases
       WHERE id = ?1 AND channel = ?2 AND file_name = ?3 AND status = 'published'
       LIMIT 1`,
  )
    .bind(route.releaseId, device.ring, route.fileName)
    .first();
  if (!release || release.rollout_percent <= 0) return null;
  const bucket = await rolloutBucket(device.id, release.id);
  return bucket < release.rollout_percent ? release : null;
}

async function handleArtifact(request, env, device, route) {
  const release = await authorizedRelease(env, device, route);
  if (!release) return json({ error: "not found" }, 404);

  if (request.method === "HEAD") {
    const object = await env.ARTIFACTS.head(release.artifact_key);
    if (!object) return json({ error: "artifact missing" }, 404);
    const headers = new Headers({
      "content-length": String(object.size),
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: object.httpEtag,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    return new Response(null, { status: 200, headers });
  }

  const rangeRequested = request.headers.has("range");
  const object = await env.ARTIFACTS.get(
    release.artifact_key,
    rangeRequested ? { range: request.headers } : undefined,
  );
  if (!object) return json({ error: "artifact missing" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", `attachment; filename="${release.file_name.replaceAll('"', '')}"`);

  let status = 200;
  if (rangeRequested && object.range && "offset" in object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    headers.set("content-length", String(object.range.length));
    status = 206;
  } else {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, environment: env.ENVIRONMENT, service: "hermes-desktop-hot-update" });
    }

    const check = request.method === "GET" ? checkRoute(url.pathname) : null;
    const artifact = ["GET", "HEAD"].includes(request.method)
      ? artifactRoute(url.pathname)
      : null;
    if (!check && !artifact) return json({ error: "not found" }, 404);

    const device = await authenticate(request, env, ctx);
    if (!device) return json({ error: "unauthorized" }, 401);
    if (check) return handleCheck(request, env, device, check);
    return handleArtifact(request, env, device, artifact);
  },
};
