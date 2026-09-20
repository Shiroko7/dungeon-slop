/**
 * The application schema, v3.
 *
 * Everything the app owns lives in one SQLite file, because the ownership tree
 * only means anything if a delete can cascade through it. A campaign that lived
 * in localStorage while its notes lived here would leak chunk and embedding rows
 * on every delete, and nothing would ever collect them.
 *
 * Every statement is `IF NOT EXISTS`, so this file is safe to run against a
 * database at any version. Shape changes that `IF NOT EXISTS` cannot express —
 * the v1 `documents` table, which predates campaigns — live in `migrate.ts` and
 * run first.
 */
export const SCHEMA_VERSION = 6;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── campaigns: the only root ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  blurb      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─── notes ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  filename     TEXT    NOT NULL,
  uploaded_at  INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  summary      TEXT    NOT NULL DEFAULT '',
  entities     TEXT    NOT NULL DEFAULT '[]',
  tokens       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (campaign_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_documents_campaign ON documents (campaign_id, filename);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  heading_path TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  tokens       INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  UNIQUE (doc_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks (doc_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (
  text,
  heading_path,
  content = 'chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text, heading_path)
  VALUES (new.id, new.text, new.heading_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, heading_path)
  VALUES ('delete', old.id, old.text, old.heading_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, heading_path)
  VALUES ('delete', old.id, old.text, old.heading_path);
  INSERT INTO chunks_fts (rowid, text, heading_path)
  VALUES (new.id, new.text, new.heading_path);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vec      BLOB    NOT NULL
);

-- ─── dungeons ───────────────────────────────────────────────────────────────

/*
 * Geometry is stored whole. The engine emits a complete Dungeon in one shot,
 * so splitting rooms into rows would let the blob and the rows disagree and
 * turn every render into a join. What is genuinely per-room and long-lived is
 * authorship, and that goes in "room_notes".
 *
 * "parent_id" records a reroll: a reroll inserts a sibling rather than
 * overwriting, because new geometry means new room ids and overwriting silently
 * discards every description already written against the old ones.
 */
CREATE TABLE IF NOT EXISTS dungeons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  revision    INTEGER NOT NULL DEFAULT 0,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  parent_id   INTEGER          REFERENCES dungeons(id) ON DELETE SET NULL,
  fork_operation_id TEXT,
  name        TEXT    NOT NULL,
  seed        INTEGER,
  config      TEXT,
  geometry    TEXT,
  overview    TEXT,
  blueprint   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dungeons_campaign ON dungeons (campaign_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dungeons_fork_operation
  ON dungeons (parent_id, fork_operation_id)
  WHERE fork_operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dungeon_mutations (
  dungeon_id INTEGER NOT NULL REFERENCES dungeons(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (dungeon_id, operation_id)
);

CREATE TABLE IF NOT EXISTS room_notes (
  dungeon_id  INTEGER NOT NULL REFERENCES dungeons(id) ON DELETE CASCADE,
  room_index  INTEGER NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (dungeon_id, room_index)
);

CREATE TABLE IF NOT EXISTS authored_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dungeon_id  INTEGER NOT NULL REFERENCES dungeons(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('overview', 'room')),
  room_index  INTEGER,
  content     TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'before-replace',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authored_revisions_dungeon
  ON authored_revisions (dungeon_id, created_at DESC);

-- ─── chats ──────────────────────────────────────────────────────────────────

/*
 * One table, not two. "dungeon_id IS NULL" is a Loremaster thread over the
 * campaign's notes; a set "dungeon_id" is that dungeon's Architect build log.
 * Splitting them would duplicate "messages" and every read path for no gain.
 */
CREATE TABLE IF NOT EXISTS chats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  dungeon_id  INTEGER          REFERENCES dungeons(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_campaign ON chats (campaign_id, updated_at DESC);

-- Exactly one Architect thread per dungeon; Loremaster threads are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_dungeon
  ON chats (dungeon_id) WHERE dungeon_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  tool_calls TEXT,
  citations  TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id);

-- ─── usage ledger ───────────────────────────────────────────────────────────

/*
 * One row per model call, written after the call completes. This is an
 * accounting ledger, so the owner references are ON DELETE SET NULL rather than
 * CASCADE: deleting a dungeon must not erase the record that money was spent
 * generating it. Orphaned rows still count toward the lifetime total, which is
 * the only figure that has to stay honest.
 *
 * Token counts are stored raw and priced at read time. Rates change, and a
 * stored dollar figure would silently become a lie the next time Google
 * repriced; recomputing from src/ai/pricing.ts keeps one source of truth.
 *
 * "reasoning" holds the model's thought summary when it was requested - kept
 * next to the tokens it cost, since that is where the question "why did it pick
 * these values, and what did it charge me to decide" gets answered.
 */
CREATE TABLE IF NOT EXISTS usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER          REFERENCES campaigns(id) ON DELETE SET NULL,
  dungeon_id      INTEGER          REFERENCES dungeons(id)  ON DELETE SET NULL,
  chat_id         INTEGER          REFERENCES chats(id)     ON DELETE SET NULL,
  operation       TEXT    NOT NULL,
  provider        TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning       TEXT,
  failed          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_dungeon  ON usage_events (dungeon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_chat     ON usage_events (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_campaign ON usage_events (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_created  ON usage_events (created_at DESC);

-- ─── bookkeeping ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
