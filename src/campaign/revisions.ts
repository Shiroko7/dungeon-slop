import type { Database } from "bun:sqlite";
import type { DungeonDescription, RoomDescription } from "../engine/types.ts";
import type { DungeonPatch, DungeonRevision } from "./types.ts";

interface RevisionRow {
  id: number;
  dungeon_id: number;
  kind: "overview" | "room";
  room_index: number | null;
  content: string;
  source: string;
  created_at: number;
}

function parseContent(row: RevisionRow): DungeonRevision | null {
  try {
    return {
      id: row.id,
      dungeonId: row.dungeon_id,
      kind: row.kind,
      roomIndex: row.room_index,
      content: JSON.parse(row.content) as DungeonDescription | RoomDescription,
      source: row.source,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

export function listDungeonRevisions(
  db: Database,
  dungeonId: number,
  options: { kind?: "overview" | "room"; roomIndex?: number } = {},
): DungeonRevision[] {
  const clauses = ["dungeon_id = ?"];
  const values: unknown[] = [dungeonId];
  if (options.kind) {
    clauses.push("kind = ?");
    values.push(options.kind);
  }
  if (options.roomIndex !== undefined) {
    clauses.push("room_index = ?");
    values.push(options.roomIndex);
  }
  const rows = db
    .query(
      `SELECT id, dungeon_id, kind, room_index, content, source, created_at
       FROM authored_revisions WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(...(values as never[])) as RevisionRow[];
  return rows.flatMap((row) => {
    const parsed = parseContent(row);
    return parsed === null ? [] : [parsed];
  });
}

export function getDungeonRevision(
  db: Database,
  dungeonId: number,
  revisionId: number,
): DungeonRevision | null {
  const row = db
    .query(
      `SELECT id, dungeon_id, kind, room_index, content, source, created_at
       FROM authored_revisions WHERE dungeon_id = ? AND id = ?`,
    )
    .get(dungeonId, revisionId) as RevisionRow | null;
  return row === null ? null : parseContent(row);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Save before-images for authored fields that are about to be replaced. */
export function checkpointAuthoredContent(
  db: Database,
  dungeonId: number,
  current: {
    overview: DungeonDescription | null;
    roomNotes: Array<[number, RoomDescription]>;
  },
  patch: DungeonPatch,
): void {
  const now = Date.now();
  if (
    patch.overview !== undefined &&
    current.overview !== null &&
    !sameJson(current.overview, patch.overview)
  ) {
    db.run(
      `INSERT INTO authored_revisions
       (dungeon_id, kind, room_index, content, source, created_at)
       VALUES (?, 'overview', NULL, ?, 'before-replace', ?)`,
      [dungeonId, JSON.stringify(current.overview), now],
    );
  }

  if (patch.roomNotes === undefined) return;
  const previous = new Map(current.roomNotes);
  for (const [roomIndex, next] of patch.roomNotes) {
    const old = previous.get(roomIndex);
    if (old === undefined || sameJson(old, next)) continue;
    db.run(
      `INSERT INTO authored_revisions
       (dungeon_id, kind, room_index, content, source, created_at)
       VALUES (?, 'room', ?, ?, 'before-replace', ?)`,
      [dungeonId, roomIndex, JSON.stringify(old), now],
    );
  }
}
