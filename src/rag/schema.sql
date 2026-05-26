-- pgvector schema for RAG (idempotent — executed on module init)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS course_documents (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  summary         TEXT,
  goals           JSONB,
  categories      JSONB,
  teacher_id      INTEGER,
  teacher_name    TEXT,
  average_rating  DOUBLE PRECISION,
  duration_sec    INTEGER,
  ingested_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lesson_documents (
  id            INTEGER PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES course_documents(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  duration_sec  INTEGER,
  ingested_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lesson_course ON lesson_documents(course_id);

CREATE TABLE IF NOT EXISTS transcript_chunks (
  id            BIGSERIAL PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES course_documents(id) ON DELETE CASCADE,
  lesson_id     INTEGER NOT NULL REFERENCES lesson_documents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  text          TEXT NOT NULL,
  token_count   INTEGER NOT NULL,
  embedding     vector(768),
  UNIQUE(lesson_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunk_course ON transcript_chunks(course_id);
CREATE INDEX IF NOT EXISTS idx_chunk_lesson ON transcript_chunks(lesson_id);

-- HNSW index for cosine similarity (built lazily during ingestion to keep insert speed)
CREATE INDEX IF NOT EXISTS idx_chunk_embedding_hnsw
  ON transcript_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
