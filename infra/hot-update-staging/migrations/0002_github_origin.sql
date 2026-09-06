PRAGMA foreign_keys = ON;

ALTER TABLE releases ADD COLUMN github_release_tag TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN github_asset_url TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN mirror_url TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN desktop_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN core_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN bundled_runtime_tag TEXT NOT NULL DEFAULT '';

CREATE INDEX releases_github_tag_idx ON releases (github_release_tag);

CREATE TABLE release_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT,
  action TEXT NOT NULL CHECK (
    action IN ('register-draft', 'promote', 'set-percent', 'pause', 'revoke')
  ),
  actor TEXT NOT NULL,
  workflow_url TEXT,
  before_state TEXT,
  after_state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE INDEX release_events_release_created_idx
  ON release_events (release_id, created_at DESC);

CREATE TABLE client_update_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_sha256 TEXT NOT NULL CHECK (length(identity_sha256) = 64),
  device_id TEXT,
  release_id TEXT,
  channel TEXT NOT NULL,
  event TEXT NOT NULL,
  app_version TEXT,
  manifest_source TEXT,
  download_source TEXT,
  fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE INDEX client_update_events_release_created_idx
  ON client_update_events (release_id, created_at DESC);
