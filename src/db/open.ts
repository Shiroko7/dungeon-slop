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
export function openAppDb(path: string = DEFAULT_DB_PATH): Database {
  const db = new Database(path, { create: true });
  // Not persisted in the file — has to be re-asserted on every connection.
  db.run("PRAGMA foreign_keys = ON");

  runMigrations(db);
  db.run(SCHEMA);

  db.run(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(SCHEMA_VERSION)],
  );

  return db;
}
