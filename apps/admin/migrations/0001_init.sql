-- kumodana initial schema. See specs/001-share-shelf-mvp/data-model.md.

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 99999999),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'deleting')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Same content is stored once, except for files that are being deleted.
CREATE UNIQUE INDEX files_sha256_live ON files (sha256) WHERE status != 'deleting';
CREATE INDEX files_status_updated ON files (status, updated_at);
CREATE INDEX files_created ON files (created_at);

CREATE TABLE file_tags (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
  PRIMARY KEY (file_id, tag)
);

CREATE INDEX file_tags_tag ON file_tags (tag);

CREATE TABLE links (
  token TEXT PRIMARY KEY CHECK (length(token) = 22),
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  label TEXT CHECK (label IS NULL OR length(label) <= 200),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX links_file ON links (file_id);
