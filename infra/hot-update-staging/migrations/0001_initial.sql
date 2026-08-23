PRAGMA foreign_keys = ON;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  ring TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT
);

CREATE INDEX devices_ring_status_idx ON devices (ring, status);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  target TEXT NOT NULL,
  arch TEXT NOT NULL,
  bundle_type TEXT NOT NULL,
  artifact_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  signature TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size > 0),
  bundled_core_version TEXT NOT NULL,
  bundled_runtime_version TEXT NOT NULL,
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision >= 0),
  notes TEXT NOT NULL DEFAULT '',
  pub_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'revoked')),
  rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT,
  UNIQUE (channel, version, target, arch)
);

CREATE INDEX releases_lookup_idx
  ON releases (channel, target, arch, status, sequence DESC);
