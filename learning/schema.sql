PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
    body TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS document_sources (
    source_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
    origin TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS excluded_sources (source_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS revisions (
    document_id TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(document_id,revision)
);
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
    ordinal INTEGER NOT NULL, body TEXT NOT NULL,
    FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision)
);
CREATE INDEX IF NOT EXISTS chunk_revision ON chunks(document_id,revision,ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, keywords);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
