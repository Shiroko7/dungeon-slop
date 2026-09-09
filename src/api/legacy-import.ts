import { appDb } from "../db/context.ts";
import { createCampaign, listCampaigns } from "../campaign/campaigns.ts";
import { createDungeon, upsertRoomNote } from "../campaign/dungeons.ts";
import { architectChat, replaceMessages } from "../campaign/chats.ts";
import { getMeta, setMeta } from "../notes/db.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import type { Dungeon, DungeonDescription, RoomDescription } from "../engine/types.ts";
import type { MessageInput } from "../campaign/types.ts";
import { json, readJson, serverError } from "./http.ts";

const DONE_KEY = "legacy_import";

interface LegacyMessage {
  role: "user" | "assistant";
  content: string;
}

interface LegacySnapshot {
  config: DungeonConfig | null;
  dungeon: Dungeon | null;
  overview?: DungeonDescription | null;
  roomDescriptions?: Array<[number, RoomDescription]>;
  conversationHistory?: LegacyMessage[];
  label?: string;
  timestamp?: number;
}

interface LegacyPayload {
  /** The live dungeon-store state, if there was one. */
  current?: LegacySnapshot | null;
  /** `history-store.past`, oldest first. */
  history?: LegacySnapshot[];
}

/**
 * GET /api/legacy-import — has the one-shot import already run?
 *
 * The browser asks before reading its own localStorage, so a second machine
 * pointed at the same database never re-imports and never duplicates.
 */
export function handleLegacyImportStatus(): Response {
  const db = appDb();
  return json({
    done: getMeta(db, DONE_KEY) !== null,
    campaigns: listCampaigns(db).length,
  });
}

function isMessage(value: unknown): value is LegacyMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<LegacyMessage>;
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
}

/** Labels were built from the first 44 characters of a prompt; they make decent names. */
function nameFrom(snapshot: LegacySnapshot, fallback: string): string {
  const label = (snapshot.label ?? "").trim();
  if (label !== "") return label.length > 60 ? `${label.slice(0, 60)}…` : label;
  const motif = snapshot.config?.motif;
  return motif === undefined ? fallback : `${motif} dungeon`;
}

function importSnapshot(
  db: ReturnType<typeof appDb>,
  campaignId: number,
  snapshot: LegacySnapshot,
  fallbackName: string,
): number {
  const record = createDungeon(db, campaignId, {
    name: nameFrom(snapshot, fallbackName),
    seed: snapshot.config?.seed ?? null,
    config: snapshot.config ?? null,
    geometry: snapshot.dungeon ?? null,
    overview: snapshot.overview ?? null,
  });

  for (const entry of snapshot.roomDescriptions ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [roomIndex, description] = entry;
    if (typeof roomIndex !== "number" || description == null) continue;
    upsertRoomNote(db, record.id, roomIndex, description);
  }

  const messages = (snapshot.conversationHistory ?? []).filter(isMessage);
  if (messages.length > 0) {
    const chat = architectChat(db, record.id);
    replaceMessages(db, chat.id, messages as MessageInput[]);
  }

  return record.id;
}

/**
 * POST /api/legacy-import — move what lived in localStorage into the database.
 *
 * Runs client-side-first by necessity: localStorage is not reachable from Bun,
 * so the browser reads its own keys and posts them here. The `meta` stamp makes
 * it idempotent from the server's side regardless of how many tabs try.
 *
 * History entries become sibling dungeons, which is what they always were —
 * `history-store` existed only because there was nowhere else to put a second
 * map. The entry matching the live dungeon is skipped, because generating
 * pushed to history *and* set the current state, so the newest entry is
 * normally a duplicate of it.
 */
export async function handleLegacyImport(req: Request): Promise<Response> {
  const db = appDb();
  if (getMeta(db, DONE_KEY) !== null) {
    return json({ imported: 0, skipped: true, reason: "already imported" });
  }

  const payload = await readJson<LegacyPayload>(req);
  if (payload === null) return json({ error: "Expected a JSON body" }, 400);

  const history = Array.isArray(payload.history) ? payload.history : [];
  const current = payload.current ?? null;
  const hasCurrent = current !== null && current.dungeon != null;

  if (!hasCurrent && history.length === 0) {
    setMeta(db, DONE_KEY, String(Date.now()));
    return json({ imported: 0, skipped: true, reason: "nothing to import" });
  }

  try {
    // Prefer the campaign the notes migration already created, so imported maps
    // land beside the notes they were written against instead of in a new silo.
    const existing = listCampaigns(db);
    const campaign =
      existing[existing.length - 1] ?? createCampaign(db, { name: "Default Campaign" });

    const currentKey = hasCurrent ? JSON.stringify(current.dungeon) : null;
    let imported = 0;

    for (const [i, snapshot] of history.entries()) {
      if (snapshot?.dungeon == null) continue;
      if (currentKey !== null && JSON.stringify(snapshot.dungeon) === currentKey) continue;
      importSnapshot(db, campaign.id, snapshot, `Map ${i + 1}`);
      imported++;
    }

    let currentId: number | null = null;
    if (hasCurrent) {
      currentId = importSnapshot(db, campaign.id, current, "Current map");
      imported++;
    }

    setMeta(db, DONE_KEY, String(Date.now()));
    return json({ imported, campaignId: campaign.id, currentDungeonId: currentId });
  } catch (err) {
    return serverError(err);
  }
}
