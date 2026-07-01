-- Initial schema for the collaborative code editor.
-- Applied by src/db/migrate.ts, tracked in schema_migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  color         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  link_access   TEXT NOT NULL DEFAULT 'viewer' CHECK (link_access IN ('none', 'viewer', 'editor')),
  language      TEXT NOT NULL DEFAULT 'javascript',
  -- Latest merged Yjs state (Y.encodeStateAsUpdate output). O(doc size),
  -- never an operation log -- see DESIGN.md #2.
  state         BYTEA,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

CREATE TABLE IF NOT EXISTS document_permissions (
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

CREATE TABLE IF NOT EXISTS document_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq           INT NOT NULL,
  label         TEXT,
  state         BYTEA NOT NULL,
  text_excerpt  TEXT NOT NULL,
  size_bytes    INT NOT NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_document ON document_snapshots(document_id, seq DESC);
