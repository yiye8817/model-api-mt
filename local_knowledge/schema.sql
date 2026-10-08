CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
 enabled INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 revision INTEGER NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source_revision ON chunks(source_id, revision);
CREATE TABLE IF NOT EXISTS qa_records (id TEXT PRIMARY KEY, source_id TEXT, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answer_cache (
 fingerprint TEXT PRIMARY KEY, model_fingerprint TEXT NOT NULL,
 valid_until REAL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache_dependencies (
 fingerprint TEXT NOT NULL REFERENCES answer_cache(fingerprint) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL,
 PRIMARY KEY (fingerprint, source_id)
);
CREATE TABLE IF NOT EXISTS index_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS request_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS online_calls (
 request_id TEXT NOT NULL, call_id TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
 PRIMARY KEY(request_id,call_id)
);
CREATE TABLE IF NOT EXISTS evaluation_profiles (id TEXT PRIMARY KEY, body TEXT NOT NULL);
PRAGMA user_version = 1;
