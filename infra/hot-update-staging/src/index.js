const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const RESTRICTED_CHANNELS = new Set(["prototype", "canary", "beta"]);
const ALL_CHANNELS = new Set([...RESTRICTED_CHANNELS, "stable"]);
const CLIENT_EVENTS = new Set([
  "check",
  "download-start",
  "download-success",
  "download-failure",
  "fallback",
  "install-start",
  "install-success",
  "install-failure",
]);
const FIXED_REPOSITORY_PATH = ["Eynzof", "Hermes-CN-Desktop", "releases", "download"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function noContent() {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
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

export async function rolloutBucket(identity, releaseId) {
  const hash = await sha256Hex(`${identity}:${releaseId}`);
  return Number.parseInt(hash.slice(0, 8), 16) % 100;
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeSegment(value) {
  return /^[0-9A-Za-z._-]{1,128}$/.test(value);
}

function safeAssetName(value) {
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,254}$/.test(value);
}

export function parseCheckRoute(pathname) {
  const match = pathname.match(/^\/v1\/check\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  let parts;
  try {
    parts = match.slice(1).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  const [channel, target, arch, currentVersion] = parts;
  if (!ALL_CHANNELS.has(channel) || !safeSegment(target) || !safeSegment(arch)) return null;
  if (!parseSemver(currentVersion)) return null;
  return { channel, target, arch, currentVersion };
}

async function restrictedIdentity(request, env, ctx, channel) {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const device = await env.UPDATES.prepare(
    "SELECT id, ring, status, last_seen_at FROM devices WHERE token_sha256 = ?1 LIMIT 1",
  )
    .bind(tokenHash)
    .first();
  if (!device || device.status !== "active" || device.ring !== channel) return null;
  const claimedDeviceId = request.headers.get("x-device-id");
  if (claimedDeviceId && claimedDeviceId !== device.id) return null;

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
  return { identity: device.id, deviceId: device.id, channel };
}

function stableIdentity(request) {
  const installationId = request.headers.get("x-installation-id")?.trim() ?? "";
  if (!safeSegment(installationId) || installationId.length < 16) return null;
  return { identity: installationId, deviceId: null, channel: "stable" };
}

async function authenticateChannel(request, env, ctx, channel) {
  if (channel === "stable") return stableIdentity(request);
  return restrictedIdentity(request, env, ctx, channel);
}

async function releaseForIdentity(env, identity, channel, target, arch) {
  const release = await env.UPDATES.prepare(
    `SELECT * FROM releases
       WHERE channel = ?1 AND target = ?2 AND arch = ?3 AND status = 'published'
       ORDER BY sequence DESC
       LIMIT 1`,
  )
    .bind(channel, target, arch)
    .first();
  if (!release || release.rollout_percent <= 0) return null;
  const bucket = await rolloutBucket(identity, release.id);
  return bucket < release.rollout_percent ? release : null;
}

export function validateReleaseOrigin(release, mirrorOrigin) {
  if (!release.github_release_tag || release.github_release_tag !== `v${release.version}`) {
    throw new Error("release tag/version mismatch");
  }
  if (!safeAssetName(release.file_name) || release.file_name.includes("%")) {
    throw new Error("invalid release asset name");
  }
  const github = new URL(release.github_asset_url);
  const segments = github.pathname.split("/").filter(Boolean);
  if (
    github.protocol !== "https:" ||
    github.hostname !== "github.com" ||
    github.username ||
    github.password ||
    github.search ||
    github.hash ||
    segments.length !== 6 ||
    !FIXED_REPOSITORY_PATH.every((part, index) => segments[index] === part) ||
    segments[4] !== release.github_release_tag ||
    segments[5] !== release.file_name
  ) {
    throw new Error("invalid GitHub release origin");
  }

  const expectedMirror = new URL(
    `/${encodeURIComponent(release.github_release_tag)}/${encodeURIComponent(release.file_name)}`,
    `${mirrorOrigin.replace(/\/$/, "")}/`,
  );
  const actualMirror = new URL(release.mirror_url);
  if (actualMirror.href !== expectedMirror.href) throw new Error("invalid mirror URL");
  return { github, mirror: actualMirror };
}

export function updaterResponse(release, mirrorOrigin) {
  validateReleaseOrigin(release, mirrorOrigin);
  return {
    version: release.version,
    pub_date: release.pub_date,
    url: release.mirror_url,
    signature: release.signature,
    notes: release.notes,
    metadata: {
      schemaVersion: 2,
      releaseId: release.id,
      channel: release.channel,
      githubReleaseTag: release.github_release_tag,
      githubFallbackUrl: release.github_asset_url,
      sha256: release.sha256,
      size: release.size,
      bundledCoreVersion: release.bundled_core_version,
      bundledRuntimeVersion: release.bundled_runtime_version,
      runtimeRevision: release.runtime_revision,
    },
  };
}

async function handleCheck(request, env, identity, route) {
  const release = await releaseForIdentity(
    env,
    identity.identity,
    route.channel,
    route.target,
    route.arch,
  );
  if (!release) return noContent();
  if (compareSemver(release.version, route.currentVersion) <= 0) return noContent();
  try {
    return json(updaterResponse(release, env.MIRROR_ORIGIN));
  } catch (error) {
    console.error("invalid registered release", release.id, error);
    return json({ error: "release metadata invalid" }, 500);
  }
}

async function parseEventBody(request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) throw new Error("event too large");
  const body = await request.json();
  if (!body || typeof body !== "object") throw new Error("invalid event body");
  if (!ALL_CHANNELS.has(body.channel) || !CLIENT_EVENTS.has(body.event)) {
    throw new Error("invalid event type or channel");
  }
  for (const field of ["releaseId", "appVersion", "errorCode"]) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new Error(`invalid ${field}`);
    }
  }
  return body;
}

async function handleEvent(request, env, ctx) {
  let body;
  try {
    body = await parseEventBody(request);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const identity = await authenticateChannel(request, env, ctx, body.channel);
  if (!identity) return json({ error: "unauthorized" }, 401);
  const identityHash = await sha256Hex(identity.identity);
  await env.UPDATES.prepare(
    `INSERT INTO client_update_events
      (identity_sha256, device_id, release_id, channel, event, app_version,
       manifest_source, download_source, fallback_used, error_code)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      identityHash,
      identity.deviceId,
      body.releaseId ?? null,
      body.channel,
      body.event,
      body.appVersion ?? null,
      body.manifestSource ?? null,
      body.downloadSource ?? null,
      body.fallbackUsed ? 1 : 0,
      body.errorCode ?? null,
    )
    .run();
  return noContent();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        environment: env.ENVIRONMENT,
        service: "hermes-desktop-hot-update-control",
        artifactOrigin: "github-release",
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/events") {
      return handleEvent(request, env, ctx);
    }
    if (request.method !== "GET") return json({ error: "not found" }, 404);
    const route = parseCheckRoute(url.pathname);
    if (!route) return json({ error: "not found" }, 404);
    const identity = await authenticateChannel(request, env, ctx, route.channel);
    if (!identity) return json({ error: "unauthorized" }, 401);
    return handleCheck(request, env, identity, route);
  },
};
