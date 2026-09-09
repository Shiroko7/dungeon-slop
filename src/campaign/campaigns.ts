import type { Database } from "bun:sqlite";
import type { Campaign, CampaignInput } from "./types.ts";

interface CampaignRow {
  id: number;
  name: string;
  blurb: string;
  created_at: number;
  updated_at: number;
  note_count: number;
  dungeon_count: number;
  chat_count: number;
}

/**
 * Counts come from correlated subqueries rather than joins: three `LEFT JOIN`s
 * against the same root would multiply rows and need a `GROUP BY` over every
 * selected column to undo the damage.
 */
const CAMPAIGN_SELECT = `
  SELECT c.id, c.name, c.blurb, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM documents d WHERE d.campaign_id = c.id) AS note_count,
         (SELECT COUNT(*) FROM dungeons  g WHERE g.campaign_id = c.id) AS dungeon_count,
         (SELECT COUNT(*) FROM chats     h WHERE h.campaign_id = c.id
                                           AND h.dungeon_id IS NULL)   AS chat_count
  FROM campaigns c
`;

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    blurb: row.blurb,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    noteCount: row.note_count,
    dungeonCount: row.dungeon_count,
    chatCount: row.chat_count,
  };
}

export function listCampaigns(db: Database): Campaign[] {
  const rows = db
    .query(`${CAMPAIGN_SELECT} ORDER BY c.updated_at DESC`)
    .all() as CampaignRow[];
  return rows.map(toCampaign);
}

export function getCampaign(db: Database, id: number): Campaign | null {
  const row = db.query(`${CAMPAIGN_SELECT} WHERE c.id = ?`).get(id) as CampaignRow | null;
  return row === null ? null : toCampaign(row);
}

export function createCampaign(db: Database, input: CampaignInput): Campaign {
  const name = input.name.trim();
  if (name === "") throw new Error("A campaign needs a name");

  const now = Date.now();
  db.run("INSERT INTO campaigns (name, blurb, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    name,
    input.blurb?.trim() ?? "",
    now,
    now,
  ]);
  const id = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);

  const created = getCampaign(db, id);
  if (created === null) throw new Error(`Campaign ${id} vanished immediately after insert`);
  return created;
}

export function updateCampaign(
  db: Database,
  id: number,
  patch: Partial<CampaignInput>,
): Campaign | null {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === "") throw new Error("A campaign needs a name");
    sets.push("name = ?");
    values.push(name);
  }
  if (patch.blurb !== undefined) {
    sets.push("blurb = ?");
    values.push(patch.blurb.trim());
  }
  if (sets.length === 0) return getCampaign(db, id);

  sets.push("updated_at = ?");
  values.push(Date.now(), id);
  db.run(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`, values as never[]);
  return getCampaign(db, id);
}

/**
 * Deletes the campaign and, by cascade, its notes, chunks, embeddings,
 * dungeons, room notes, chats and messages. Foreign keys must be on for that to
 * happen — `openAppDb` asserts the pragma per connection.
 */
export function deleteCampaign(db: Database, id: number): boolean {
  const before = db.query("SELECT id FROM campaigns WHERE id = ?").get(id);
  if (before === null) return false;
  db.run("DELETE FROM campaigns WHERE id = ?", [id]);
  return true;
}

/** Bump `updated_at` so the campaign sorts to the top of the picker. */
export function touchCampaign(db: Database, id: number): void {
  db.run("UPDATE campaigns SET updated_at = ? WHERE id = ?", [Date.now(), id]);
}

export function campaignExists(db: Database, id: number): boolean {
  return db.query("SELECT 1 AS ok FROM campaigns WHERE id = ?").get(id) !== null;
}
