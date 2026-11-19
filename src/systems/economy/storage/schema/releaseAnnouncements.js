// Release announcement tables: github_releases and release_announcement_*.
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: github_releases, release_announcement_deliveries, release_announcement_state
const releaseTablesSql = `CREATE TABLE IF NOT EXISTS github_releases (
  release_id TEXT PRIMARY KEY NOT NULL,
  repository TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  version_major INTEGER NOT NULL CHECK (version_major >= 0),
  version_minor INTEGER NOT NULL CHECK (version_minor >= 0),
  version_patch INTEGER NOT NULL CHECK (version_patch >= 0),
  release_name TEXT NOT NULL,
  body_summary TEXT NOT NULL,
  html_url TEXT NOT NULL,
  metadata_digest TEXT NOT NULL CHECK (length(metadata_digest) = 64),
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository, tag_name)
);

CREATE TABLE IF NOT EXISTS release_announcement_deliveries (
  release_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'dead_letter', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  last_error TEXT,
  nonce TEXT NOT NULL UNIQUE,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (release_id, guild_id),
  FOREIGN KEY (release_id) REFERENCES github_releases(release_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_announcement_state (
  repository TEXT PRIMARY KEY NOT NULL,
  baseline_release_id TEXT NOT NULL,
  baseline_published_at TEXT NOT NULL,
  cursor_release_id TEXT NOT NULL,
  cursor_published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (baseline_release_id) REFERENCES github_releases(release_id),
  FOREIGN KEY (cursor_release_id) REFERENCES github_releases(release_id)
);`;

// Part of schemaSql: idx_github_releases_order, idx_release_announcement_claim
const releaseIndexesSql = `CREATE INDEX IF NOT EXISTS idx_github_releases_order
  ON github_releases (version_major, version_minor, version_patch, published_at, release_id);

CREATE INDEX IF NOT EXISTS idx_release_announcement_claim
  ON release_announcement_deliveries (status, next_attempt_at, lease_until, attempt_count, release_id, guild_id);`;

module.exports = {
  releaseTablesSql,
  releaseIndexesSql,
};
