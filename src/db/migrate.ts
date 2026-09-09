import type { Database } from "bun:sqlite";
import { SCHEMA_VERSION } from "./schema.ts";

/** Name of the campaign that adopts documents indexed before campaigns existed. */
export const ADOPTED_CAMPAIGN_NAME = "Default Campaign";

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | null;
  return row !== null;
}

function columnNames(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * v1 → v2: give `documents` a campaign.
 *
 * `UNIQUE (filename)` has to become `UNIQUE (campaign_id, filename)`, and SQLite
 * has no `ALTER TABLE ... DROP CONSTRAINT` — so this is the documented
 * create-copy-drop-rename rebuild rather than an ALTER.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 *  - Foreign keys must be off across the rebuild. `DROP TABLE documents` with
 *    them on would cascade straight through `chunks` and `embeddings` and
 *    silently destroy the index this migration exists to preserve.
 *  - `PRAGMA foreign_keys` is a no-op inside a transaction, so the pragma has to
 *    bracket the transaction rather than sit inside it. That rules out
 *    `db.transaction()` here.
 */
function migrateDocumentsToCampaigns(db: Database): boolean {
  if (!tableExists(db, "documents")) return false;
  if (columnNames(db, "documents").includes("campaign_id")) return false;

  // The FK target has to exist before the new table can reference it, and this
  // runs before the v2 schema is applied.
  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      blurb      TEXT    NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Only invent a campaign when there is something for it to hold. A v1
  // database that never indexed anything should come out of this looking like a
  // fresh install, not like it has one mysteriously empty campaign.
  const pending = (db.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;

  let campaignId: number | null = null;
  if (pending > 0) {
    const existing = db.query("SELECT id FROM campaigns ORDER BY id LIMIT 1").get() as
      | { id: number }
      | null;

    if (existing === null) {
      const now = Date.now();
      db.run("INSERT INTO campaigns (name, blurb, created_at, updated_at) VALUES (?, ?, ?, ?)", [
        ADOPTED_CAMPAIGN_NAME,
        "Notes indexed before campaigns existed.",
        now,
        now,
      ]);
      campaignId = Number(
        (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
      );
    } else {
      campaignId = existing.id;
    }
  }

  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.run("BEGIN");
    db.run(`
      CREATE TABLE documents_v2 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        filename     TEXT    NOT NULL,
        uploaded_at  INTEGER NOT NULL,
        content_hash TEXT    NOT NULL,
        summary      TEXT    NOT NULL DEFAULT '',
        entities     TEXT    NOT NULL DEFAULT '[]',
        tokens       INTEGER NOT NULL DEFAULT 0,
        UNIQUE (campaign_id, filename)
      )
    `);
    // Ids are carried across verbatim; `chunks.doc_id` still points at them.
    if (campaignId !== null) {
      db.run(
        `INSERT INTO documents_v2
           (id, campaign_id, filename, uploaded_at, content_hash, summary, entities, tokens)
         SELECT id, ?, filename, uploaded_at, content_hash, summary, entities, tokens
         FROM documents`,
        [campaignId],
      );
    }
    db.run("DROP TABLE documents");
    db.run("ALTER TABLE documents_v2 RENAME TO documents");
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    db.run("PRAGMA foreign_keys = ON");
    throw err;
  }
  db.run("PRAGMA foreign_keys = ON");

  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(
      `Migration to schema v2 left ${violations.length} dangling reference(s); ` +
        `the database has been left as-is for inspection.`,
    );
  }

  return true;
}

export interface MigrationReport {
  from: number;
  to: number;
  documentsAdopted: boolean;
}

/**
 * Bring a database up to `SCHEMA_VERSION`. Runs before the declarative schema,
 * because only shape changes that `CREATE TABLE IF NOT EXISTS` cannot express
 * belong here. Safe to call on every open: each step checks the shape it is
 * about to change rather than trusting the recorded version, so a database
 * upgraded by hand or interrupted mid-run converges instead of failing.
 */
/**
 * v3 -> v4: give `dungeons` a floor plan.
 *
 * A plain ADD COLUMN, because "CREATE TABLE IF NOT EXISTS" in the declarative
 * schema sees an existing table and does nothing at all - it would report
 * success while leaving every existing dungeon without the column.
 */
function addDungeonBlueprintColumn(db: Database): boolean {
  if (!tableExists(db, "dungeons")) return false;
  if (columnNames(db, "dungeons").includes("blueprint")) return false;
  db.run("ALTER TABLE dungeons ADD COLUMN blueprint TEXT");
  return true;
}

export function runMigrations(db: Database): MigrationReport {
  // `meta` is created by the declarative schema, which has not run yet on a
  // fresh database — so its absence means "nothing to read", not an error.
  const stamped = tableExists(db, "meta")
    ? (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | null)
    : null;
  const from = stamped === null ? 1 : Number(stamped.value);

  const documentsAdopted = migrateDocumentsToCampaigns(db);
  addDungeonBlueprintColumn(db);

  return { from, to: SCHEMA_VERSION, documentsAdopted };
}
