import { Database } from "bun:sqlite";
import { SCHEMA, SCHEMA_VERSION } from "./schema.ts";
import { runMigrations } from "./migrate.ts";

export const DEFAULT_DB_PATH = process.env.NOTES_DB_PATH ?? "notes.sqlite";

/**
 * Open the application database, migrating and creating as needed.
 *
 * Order matters: migrations run first because they reshape tables the
 * declarative schema can only create, and `CREATE TABLE IF NOT EXISTS` would
 * happily leave a v1 `documents` in place while reporting success.
 */
export function openAppDb(path: string = process.env.NOTES_DB_PATH ?? DEFAULT_DB_PATH): Database {
  const db = new Database(path, { create: true });
  // Not persisted in the file — has to be re-asserted on every connection.
  db.run("PRAGMA foreign_keys = ON");

  runMigrations(db);
  db.run(SCHEMA);

  // Idempotent legacy backfill; never replace a revision that already exists.
  db.run(`INSERT OR IGNORE INTO note_revisions
    (doc_id, revision, content_hash, chunker_version, embedding_model,
     index_status, summary_status, created_at)
    SELECT id, active_revision, content_hash, 'legacy',
      COALESCE((SELECT value FROM meta WHERE key = 'embedding_model'), 'legacy'),
      CASE WHEN EXISTS (SELECT 1 FROM chunks WHERE doc_id = documents.id)
        AND NOT EXISTS (SELECT 1 FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
                        WHERE c.doc_id = documents.id AND e.chunk_id IS NULL)
        THEN 'indexed' ELSE 'failed' END,
      CASE WHEN summary = '' THEN 'source-required' ELSE 'ready' END, uploaded_at
    FROM documents WHERE active_revision > 0`);

  db.run(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(SCHEMA_VERSION)],
  );

  return db;
}
