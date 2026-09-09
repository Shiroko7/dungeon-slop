import type { Database } from "bun:sqlite";
import { openAppDb } from "./open.ts";

/**
 * One process-wide connection. Opened lazily so importing a route never touches
 * the filesystem at module-load time, and shared because SQLite in WAL mode
 * handles concurrent readers on a single connection without ceremony.
 */
let db: Database | null = null;

export function appDb(): Database {
  db ??= openAppDb();
  return db;
}

/** Test seam: drop the cached handle so the next call reopens. */
export function closeAppDb(): void {
  db?.close();
  db = null;
}
