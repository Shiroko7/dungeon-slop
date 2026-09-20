import type { Blueprint } from "../ai/blueprint.ts";
import type { Database } from "bun:sqlite";
import type { DungeonConfig } from "../ai/schema.ts";
import type {
  Dungeon,
  DungeonDescription,
  RoomDescription,
} from "../engine/types.ts";
import { touchCampaign } from "./campaigns.ts";
import type {
  DungeonInput,
  DungeonPatch,
  DungeonRecord,
  DungeonSummary,
} from "./types.ts";

interface SummaryRow {
  id: number;
  revision: number;
  campaign_id: number;
  parent_id: number | null;
  name: string;
  seed: number | null;
  room_count: number;
  described_count: number;
  has_geometry: number;
  created_at: number;
  updated_at: number;
}

interface RecordRow extends SummaryRow {
  config: string | null;
  geometry: string | null;
  overview: string | null;
  blueprint: string | null;
}

/**
 * `room_count` is read out of the geometry blob with JSON1 rather than kept in
 * a column of its own. A denormalised count is one more thing that can disagree
 * with the geometry it describes, and the list query is small enough that the
 * scan costs nothing worth saving.
 */
const SUMMARY_COLUMNS = `
  d.id, d.revision, d.campaign_id, d.parent_id, d.name, d.seed, d.created_at, d.updated_at,
  CASE WHEN d.geometry IS NULL THEN 0
       ELSE json_array_length(d.geometry, '$.rooms') END AS room_count,
  (SELECT COUNT(*) FROM room_notes r WHERE r.dungeon_id = d.id) AS described_count,
  CASE WHEN d.geometry IS NULL THEN 0 ELSE 1 END AS has_geometry
`;

/** A stored blob that no longer parses is a bug, but never a reason to 500. */
function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toSummary(row: SummaryRow): DungeonSummary {
  return {
    id: row.id,
    revision: row.revision,
    campaignId: row.campaign_id,
    parentId: row.parent_id,
    name: row.name,
    seed: row.seed,
    roomCount: row.room_count,
    describedCount: row.described_count,
    hasGeometry: row.has_geometry === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDungeons(
  db: Database,
  campaignId: number,
): DungeonSummary[] {
  const rows = db
    .query(
      `SELECT ${SUMMARY_COLUMNS} FROM dungeons d
       WHERE d.campaign_id = ? ORDER BY d.updated_at DESC`,
    )
    .all(campaignId) as SummaryRow[];
  return rows.map(toSummary);
}

export function listRoomNotes(
  db: Database,
  dungeonId: number,
): Array<[number, RoomDescription]> {
  const rows = db
    .query(
      "SELECT room_index, description FROM room_notes WHERE dungeon_id = ? ORDER BY room_index",
    )
    .all(dungeonId) as Array<{ room_index: number; description: string }>;

  const out: Array<[number, RoomDescription]> = [];
  for (const row of rows) {
    const parsed = parseJson<RoomDescription>(row.description);
    if (parsed !== null) out.push([row.room_index, parsed]);
  }
  return out;
}

export function getDungeon(db: Database, id: number): DungeonRecord | null {
  const row = db
    .query(
      `SELECT ${SUMMARY_COLUMNS}, d.config, d.geometry, d.overview, d.blueprint
       FROM dungeons d WHERE d.id = ?`,
    )
    .get(id) as RecordRow | null;
  if (row === null) return null;

  return {
    ...toSummary(row),
    config: parseJson<DungeonConfig>(row.config),
    geometry: parseJson<Dungeon>(row.geometry),
    overview: parseJson<DungeonDescription>(row.overview),
    blueprint: parseJson<Blueprint>(row.blueprint),
    roomNotes: listRoomNotes(db, id),
  };
}

export function createDungeon(
  db: Database,
  campaignId: number,
  input: DungeonInput,
): DungeonRecord {
  const name = input.name.trim() === "" ? "Untitled map" : input.name.trim();
  const now = Date.now();

  db.run(
    `INSERT INTO dungeons
       (campaign_id, parent_id, fork_operation_id, name, seed, config, geometry, overview, blueprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      campaignId,
      input.parentId ?? null,
      input.forkOperationId ?? null,
      name,
      input.seed ?? null,
      input.config == null ? null : JSON.stringify(input.config),
      input.geometry == null ? null : JSON.stringify(input.geometry),
      input.overview == null ? null : JSON.stringify(input.overview),
      input.blueprint == null ? null : JSON.stringify(input.blueprint),
      now,
      now,
    ],
  );
  const id = Number(
    (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
  );
  touchCampaign(db, campaignId);

  const created = getDungeon(db, id);
  if (created === null)
    throw new Error(`Dungeon ${id} vanished immediately after insert`);
  return created;
}

/**
 * Patch semantics are per-field: an absent key leaves the column alone, an
 * explicit `null` clears it. That distinction is what lets the autosave send
 * only the geometry after an edit without wiping the config alongside it.
 */
export function updateDungeon(
  db: Database,
  id: number,
  patch: DungeonPatch,
): DungeonRecord | null {
  const row = db
    .query("SELECT campaign_id FROM dungeons WHERE id = ?")
    .get(id) as { campaign_id: number } | null;
  if (row === null) return null;

  const sets: string[] = [];
  const values: unknown[] = [];

  const pushJson = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    values.push(value == null ? null : JSON.stringify(value));
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    sets.push("name = ?");
    values.push(name === "" ? "Untitled map" : name);
  }
  if (patch.seed !== undefined) {
    sets.push("seed = ?");
    values.push(patch.seed);
  }
  if (patch.config !== undefined) pushJson("config", patch.config);
  if (patch.geometry !== undefined) pushJson("geometry", patch.geometry);
  if (patch.overview !== undefined) pushJson("overview", patch.overview);
  if (patch.blueprint !== undefined) pushJson("blueprint", patch.blueprint);

  for (const [roomId, description] of patch.roomNotes ?? []) {
    if (description === null) deleteRoomNote(db, id, roomId);
    else upsertRoomNote(db, id, roomId, description);
  }

  if (sets.length > 0 || patch.roomNotes !== undefined) {
    sets.push("revision = revision + 1");
    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    db.run(
      `UPDATE dungeons SET ${sets.join(", ")} WHERE id = ?`,
      values as never[],
    );
    touchCampaign(db, row.campaign_id);
  }

  return getDungeon(db, id);
}

export function deleteDungeon(db: Database, id: number): boolean {
  const row = db
    .query("SELECT campaign_id FROM dungeons WHERE id = ?")
    .get(id) as { campaign_id: number } | null;
  if (row === null) return false;
  db.run("DELETE FROM dungeons WHERE id = ?", [id]);
  touchCampaign(db, row.campaign_id);
  return true;
}

/**
 * A reroll forks rather than overwrites.
 *
 * New geometry means new room ids, so writing it over the old row would silently
 * invalidate every room description already authored against it. Inserting a
 * sibling keeps the described version reachable and makes the two comparable —
 * which is what a reroll is actually for.
 */
export function forkDungeon(
  db: Database,
  parentId: number,
  input: {
    name?: string;
    seed: number | null;
    config: DungeonConfig | null;
    geometry: Dungeon | null;
    blueprint?: Blueprint | null;
    operationId?: string;
  },
): DungeonRecord | null {
  const parent = db
    .query("SELECT campaign_id, name FROM dungeons WHERE id = ?")
    .get(parentId) as { campaign_id: number; name: string } | null;
  if (parent === null) return null;

  if (input.operationId) {
    const existing = db
      .query(
        "SELECT id FROM dungeons WHERE parent_id = ? AND fork_operation_id = ?",
      )
      .get(parentId, input.operationId) as { id: number } | null;
    if (existing !== null) return getDungeon(db, existing.id);
  }

  try {
    return createDungeon(db, parent.campaign_id, {
      name: input.name ?? nextForkName(db, parent.campaign_id, parent.name),
      seed: input.seed,
      config: input.config,
      geometry: input.geometry,
      blueprint: input.blueprint ?? null,
      parentId,
      forkOperationId: input.operationId ?? null,
    });
  } catch (error) {
    // Two browser retries can race between the lookup and INSERT. The unique
    // receipt index turns that race into the same safe replay as a lost ACK.
    if (input.operationId) {
      const existing = db
        .query(
          "SELECT id FROM dungeons WHERE parent_id = ? AND fork_operation_id = ?",
        )
        .get(parentId, input.operationId) as { id: number } | null;
      if (existing !== null) return getDungeon(db, existing.id);
    }
    throw error;
  }
}

export function getForkByOperation(
  db: Database,
  parentId: number,
  operationId: string,
): DungeonRecord | null {
  const row = db
    .query(
      "SELECT id FROM dungeons WHERE parent_id = ? AND fork_operation_id = ?",
    )
    .get(parentId, operationId) as { id: number } | null;
  return row === null ? null : getDungeon(db, row.id);
}

/**
 * "Crypt of Vess" → "Crypt of Vess (2)", then (3), and so on. Numbering is per
 * campaign so a fork never collides with a name the user chose elsewhere.
 */
function nextForkName(
  db: Database,
  campaignId: number,
  parentName: string,
): string {
  const base = parentName.replace(/\s*\(\d+\)$/, "");
  const rows = db
    .query("SELECT name FROM dungeons WHERE campaign_id = ?")
    .all(campaignId) as Array<{ name: string }>;

  const taken = new Set(rows.map((r) => r.name));
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

// ─── room notes ───────────────────────────────────────────────────────────────

export function upsertRoomNote(
  db: Database,
  dungeonId: number,
  roomIndex: number,
  description: RoomDescription,
): void {
  db.run(
    `INSERT INTO room_notes (dungeon_id, room_index, name, description, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dungeon_id, room_index) DO UPDATE
       SET name = excluded.name,
           description = excluded.description,
           updated_at = excluded.updated_at`,
    [
      dungeonId,
      roomIndex,
      description.name ?? "",
      JSON.stringify(description),
      Date.now(),
    ],
  );
  db.run("UPDATE dungeons SET updated_at = ? WHERE id = ?", [
    Date.now(),
    dungeonId,
  ]);
}

export function deleteRoomNote(
  db: Database,
  dungeonId: number,
  roomIndex: number,
): void {
  db.run("DELETE FROM room_notes WHERE dungeon_id = ? AND room_index = ?", [
    dungeonId,
    roomIndex,
  ]);
}

/** Used when geometry is replaced in place and the old descriptions no longer fit. */
export function clearRoomNotes(db: Database, dungeonId: number): void {
  db.run("DELETE FROM room_notes WHERE dungeon_id = ?", [dungeonId]);
}

export function dungeonCampaignId(
  db: Database,
  dungeonId: number,
): number | null {
  const row = db
    .query("SELECT campaign_id FROM dungeons WHERE id = ?")
    .get(dungeonId) as { campaign_id: number } | null;
  return row?.campaign_id ?? null;
}
