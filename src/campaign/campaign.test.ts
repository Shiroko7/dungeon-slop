import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAppDb } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { ADOPTED_CAMPAIGN_NAME } from "../db/migrate.ts";
import {
  campaignExists,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from "./campaigns.ts";
import {
  clearRoomNotes,
  createDungeon,
  deleteDungeon,
  forkDungeon,
  getDungeon,
  listDungeons,
  listRoomNotes,
  updateDungeon,
  upsertRoomNote,
} from "./dungeons.ts";
import {
  appendMessage,
  architectChat,
  createChat,
  deleteChat,
  getChat,
  listChats,
  replaceMessages,
  truncateMessagesFrom,
} from "./chats.ts";
import { getMeta, listDocuments, replaceDocument } from "../notes/db.ts";
import { chunkDocument } from "../notes/chunker.ts";
import type { Dungeon, RoomDescription } from "../engine/types.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dungeon-slop-test-"));
  tempDirs.push(dir);
  return join(dir, "test.sqlite");
}

afterAll(() => {
  // Best effort. Windows keeps a handle on the WAL sidecars for a moment after
  // close, and a temp directory the OS will reap anyway is not worth failing a
  // green suite over.
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left for the OS */
    }
  }
});

function fresh(): Database {
  return openAppDb(":memory:");
}

/** Minimal geometry — only the fields the accessors actually read. */
function geometryWith(roomCount: number): Dungeon {
  return {
    rooms: Array.from({ length: roomCount }, (_, i) => ({ id: i + 1 })),
    corridors: [],
  } as unknown as Dungeon;
}

function description(name: string): RoomDescription {
  return { name, features: "Damp stone." } as unknown as RoomDescription;
}

// ─── campaigns ────────────────────────────────────────────────────────────────

describe("campaigns", () => {
  test("a fresh database has none — the picker starts empty, not with a default", () => {
    expect(listCampaigns(fresh())).toEqual([]);
  });

  test("create, read back, and count what is inside", () => {
    const db = fresh();
    const created = createCampaign(db, { name: "  Ashen Vale  ", blurb: " ash and salt " });

    expect(created.name).toBe("Ashen Vale");
    expect(created.blurb).toBe("ash and salt");
    expect(created.noteCount).toBe(0);
    expect(created.dungeonCount).toBe(0);
    expect(created.chatCount).toBe(0);
    expect(getCampaign(db, created.id)?.name).toBe("Ashen Vale");
  });

  test("campaigns are independent objects, not variations on one", () => {
    const db = fresh();
    const a = createCampaign(db, { name: "Ashen Vale" });
    const b = createCampaign(db, { name: "Kestrel Reach" });

    createDungeon(db, a.id, { name: "Crypt of Vess", geometry: geometryWith(4) });
    createChat(db, b.id, { title: "who runs the inn" });

    expect(getCampaign(db, a.id)?.dungeonCount).toBe(1);
    expect(getCampaign(db, a.id)?.chatCount).toBe(0);
    expect(getCampaign(db, b.id)?.dungeonCount).toBe(0);
    expect(getCampaign(db, b.id)?.chatCount).toBe(1);
    expect(a.id).not.toBe(b.id);
  });

  test("two campaigns may share a name without colliding", () => {
    const db = fresh();
    const a = createCampaign(db, { name: "Homebrew" });
    const b = createCampaign(db, { name: "Homebrew" });
    expect(a.id).not.toBe(b.id);
    expect(listCampaigns(db)).toHaveLength(2);
  });

  test("an empty name is refused on create and on rename", () => {
    const db = fresh();
    expect(() => createCampaign(db, { name: "   " })).toThrow(/needs a name/i);

    const c = createCampaign(db, { name: "Ashen Vale" });
    expect(() => updateCampaign(db, c.id, { name: "" })).toThrow(/needs a name/i);
    expect(getCampaign(db, c.id)?.name).toBe("Ashen Vale");
  });

  test("rename leaves everything else alone", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale", blurb: "ash and salt" });
    const renamed = updateCampaign(db, c.id, { name: "The Ashen Vale" });
    expect(renamed?.name).toBe("The Ashen Vale");
    expect(renamed?.blurb).toBe("ash and salt");
  });

  test("most recently touched sorts first", () => {
    const db = fresh();
    const a = createCampaign(db, { name: "First" });
    const b = createCampaign(db, { name: "Second" });
    db.run("UPDATE campaigns SET updated_at = ? WHERE id = ?", [1, b.id]);

    expect(listCampaigns(db).map((c) => c.id)).toEqual([a.id, b.id]);
  });

  test("deleting one reports whether it existed", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    expect(deleteCampaign(db, c.id)).toBe(true);
    expect(deleteCampaign(db, c.id)).toBe(false);
    expect(campaignExists(db, c.id)).toBe(false);
  });

  test("delete cascades through dungeons, room notes, chats and messages", () => {
    const db = fresh();
    const doomed = createCampaign(db, { name: "Ashen Vale" });
    const kept = createCampaign(db, { name: "Kestrel Reach" });

    const dungeon = createDungeon(db, doomed.id, { name: "Crypt", geometry: geometryWith(3) });
    upsertRoomNote(db, dungeon.id, 1, description("Flooded Nave"));
    const chat = createChat(db, doomed.id, { title: "lore" });
    appendMessage(db, chat.id, { role: "user", content: "who runs the inn?" });

    const keptDungeon = createDungeon(db, kept.id, { name: "Keep", geometry: geometryWith(2) });

    deleteCampaign(db, doomed.id);

    expect(getDungeon(db, dungeon.id)).toBeNull();
    expect(getChat(db, chat.id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM room_notes").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(getDungeon(db, keptDungeon.id)).not.toBeNull();
  });
});

// ─── dungeons ─────────────────────────────────────────────────────────────────

describe("dungeons", () => {
  test("room count is read from the geometry, not tracked separately", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt", geometry: geometryWith(7) });

    expect(d.roomCount).toBe(7);
    expect(d.hasGeometry).toBe(true);
    expect(listDungeons(db, c.id)[0]?.roomCount).toBe(7);
  });

  test("a dungeon with no geometry yet reports zero rooms rather than failing", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Unbuilt" });

    expect(d.roomCount).toBe(0);
    expect(d.hasGeometry).toBe(false);
    expect(d.geometry).toBeNull();
  });

  test("an unnamed dungeon gets a placeholder rather than an empty title", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    expect(createDungeon(db, c.id, { name: "   " }).name).toBe("Untitled map");
  });

  test("a patch touches only the fields it names", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, {
      name: "Crypt",
      seed: 42,
      geometry: geometryWith(3),
      config: { motif: "crypt" } as never,
    });

    const patched = updateDungeon(db, d.id, { geometry: geometryWith(9) });

    expect(patched?.roomCount).toBe(9);
    expect(patched?.name).toBe("Crypt");
    expect(patched?.seed).toBe(42);
    expect(patched?.config).toEqual({ motif: "crypt" } as never);
  });

  test("an explicit null clears a field, while an absent key does not", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, {
      name: "Crypt",
      geometry: geometryWith(3),
      overview: { history: "Sank in 1104." } as never,
    });

    expect(updateDungeon(db, d.id, { name: "Crypt of Vess" })?.overview).not.toBeNull();
    expect(updateDungeon(db, d.id, { overview: null })?.overview).toBeNull();
    expect(getDungeon(db, d.id)?.geometry).not.toBeNull();
  });

  test("patching a dungeon that does not exist reports null instead of inserting", () => {
    const db = fresh();
    expect(updateDungeon(db, 999, { name: "Ghost" })).toBeNull();
    expect(deleteDungeon(db, 999)).toBe(false);
  });

  test("a stored blob that no longer parses degrades to null", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt", config: { motif: "crypt" } as never });

    db.run("UPDATE dungeons SET config = ? WHERE id = ?", ["{not json", d.id]);

    expect(getDungeon(db, d.id)?.config).toBeNull();
    expect(getDungeon(db, d.id)?.name).toBe("Crypt");
  });

  test("grounding provenance survives dungeon and room reloads", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const grounding = {
      query: "salt gate",
      documentIds: [1],
      citations: [{ campaignId: c.id, documentId: 1, revision: 2, chunkId: 3, filename: "crypt.md", headingPath: "Gate", snippet: "Below Vess", startOffset: 0, endOffset: 10 }],
      warnings: [],
      status: "ready",
      retrievedAt: 1,
    } as const;
    const d = createDungeon(db, c.id, {
      name: "Crypt",
      blueprint: { nodes: [], edges: [], grounding } as never,
      overview: { history: "The crypt.", corridorFeatures: [], wanderingMonsters: [], grounding } as never,
    });
    const saved = updateDungeon(db, d.id, { roomNotes: [[0, { name: "Gate", features: "Wet stone.", grounding } as never]] });
    expect(saved?.blueprint?.grounding?.citations[0]?.revision).toBe(2);
    expect(saved?.overview?.grounding?.query).toBe("salt gate");
    expect(getDungeon(db, d.id)?.roomNotes[0]?.[1].grounding?.citations[0]?.filename).toBe("crypt.md");
  });

  test("saving a dungeon floats its campaign to the top of the picker", () => {
    const db = fresh();
    const a = createCampaign(db, { name: "First" });
    const b = createCampaign(db, { name: "Second" });
    db.run("UPDATE campaigns SET updated_at = ? WHERE id = ?", [1, a.id]);

    createDungeon(db, a.id, { name: "Crypt" });

    expect(listCampaigns(db)[0]?.id).toBe(a.id);
    expect(listCampaigns(db)[1]?.id).toBe(b.id);
  });
});

// ─── reroll as fork ───────────────────────────────────────────────────────────

describe("reroll forks instead of overwriting", () => {
  test("the described original survives the reroll", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const original = createDungeon(db, c.id, {
      name: "Crypt of Vess",
      seed: 1,
      geometry: geometryWith(12),
    });
    upsertRoomNote(db, original.id, 4, description("Flooded Nave"));

    const fork = forkDungeon(db, original.id, {
      seed: 2,
      config: null,
      geometry: geometryWith(9),
    });

    expect(fork?.parentId).toBe(original.id);
    expect(fork?.roomCount).toBe(9);
    expect(fork?.describedCount).toBe(0);

    const kept = getDungeon(db, original.id);
    expect(kept?.roomCount).toBe(12);
    expect(kept?.roomNotes).toEqual([[4, description("Flooded Nave")]]);
  });

  test("forks are numbered, and numbering skips names already taken", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const original = createDungeon(db, c.id, { name: "Crypt of Vess" });

    const first = forkDungeon(db, original.id, { seed: 2, config: null, geometry: null });
    const second = forkDungeon(db, original.id, { seed: 3, config: null, geometry: null });

    expect(first?.name).toBe("Crypt of Vess (2)");
    expect(second?.name).toBe("Crypt of Vess (3)");
  });

  test("forking a fork keeps the base name rather than nesting suffixes", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const original = createDungeon(db, c.id, { name: "Crypt of Vess" });
    const first = forkDungeon(db, original.id, { seed: 2, config: null, geometry: null })!;

    expect(forkDungeon(db, first.id, { seed: 3, config: null, geometry: null })?.name).toBe(
      "Crypt of Vess (3)",
    );
  });

  test("a fork lands in the same campaign as its parent", () => {
    const db = fresh();
    const a = createCampaign(db, { name: "Ashen Vale" });
    createCampaign(db, { name: "Kestrel Reach" });
    const original = createDungeon(db, a.id, { name: "Crypt" });

    const fork = forkDungeon(db, original.id, { seed: 2, config: null, geometry: null });

    expect(fork?.campaignId).toBe(a.id);
    expect(listDungeons(db, a.id)).toHaveLength(2);
  });

  test("deleting the parent leaves the fork standing, unparented", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const original = createDungeon(db, c.id, { name: "Crypt" });
    const fork = forkDungeon(db, original.id, { seed: 2, config: null, geometry: null })!;

    deleteDungeon(db, original.id);

    expect(getDungeon(db, fork.id)?.parentId).toBeNull();
  });

  test("forking something that does not exist is a null, not a throw", () => {
    const db = fresh();
    expect(forkDungeon(db, 999, { seed: 1, config: null, geometry: null })).toBeNull();
  });
});

// ─── room notes ───────────────────────────────────────────────────────────────

describe("room notes", () => {
  test("upsert replaces rather than duplicating", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt", geometry: geometryWith(5) });

    upsertRoomNote(db, d.id, 2, description("Cistern"));
    upsertRoomNote(db, d.id, 2, description("The Cistern"));

    expect(listRoomNotes(db, d.id)).toEqual([[2, description("The Cistern")]]);
    expect(getDungeon(db, d.id)?.describedCount).toBe(1);
  });

  test("notes are keyed per dungeon, never shared between them", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const a = createDungeon(db, c.id, { name: "Crypt", geometry: geometryWith(5) });
    const b = createDungeon(db, c.id, { name: "Keep", geometry: geometryWith(5) });

    upsertRoomNote(db, a.id, 1, description("Entry Hall"));

    expect(listRoomNotes(db, b.id)).toEqual([]);
    expect(getDungeon(db, b.id)?.describedCount).toBe(0);
  });

  test("notes come back in room order", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt", geometry: geometryWith(9) });

    for (const i of [7, 1, 4]) upsertRoomNote(db, d.id, i, description(`Room ${i}`));

    expect(listRoomNotes(db, d.id).map(([i]) => i)).toEqual([1, 4, 7]);
  });

  test("deleting a dungeon takes its notes with it", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt", geometry: geometryWith(5) });
    upsertRoomNote(db, d.id, 1, description("Entry"));

    deleteDungeon(db, d.id);

    expect(db.query("SELECT COUNT(*) AS n FROM room_notes").get()).toEqual({ n: 0 });
  });

  test("clearing is scoped to one dungeon", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const a = createDungeon(db, c.id, { name: "Crypt", geometry: geometryWith(3) });
    const b = createDungeon(db, c.id, { name: "Keep", geometry: geometryWith(3) });
    upsertRoomNote(db, a.id, 1, description("A"));
    upsertRoomNote(db, b.id, 1, description("B"));

    clearRoomNotes(db, a.id);

    expect(listRoomNotes(db, a.id)).toEqual([]);
    expect(listRoomNotes(db, b.id)).toHaveLength(1);
  });
});

// ─── chats ────────────────────────────────────────────────────────────────────

describe("chats", () => {
  test("a campaign lists its Loremaster threads and not its Architect logs", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt" });

    createChat(db, c.id, { title: "who runs the inn" });
    architectChat(db, d.id);

    expect(listChats(db, c.id).map((t) => t.title)).toEqual(["who runs the inn"]);
    expect(getCampaign(db, c.id)?.chatCount).toBe(1);
  });

  test("a dungeon has exactly one Architect thread, created on first ask", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt" });

    const first = architectChat(db, d.id);
    const second = architectChat(db, d.id);

    expect(second.id).toBe(first.id);
    expect(db.query("SELECT COUNT(*) AS n FROM chats").get()).toEqual({ n: 1 });
  });

  test("the schema refuses a second Architect thread even if one is inserted directly", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt" });
    architectChat(db, d.id);

    expect(() => createChat(db, c.id, { dungeonId: d.id })).toThrow();
  });

  test("Loremaster threads are unconstrained — a campaign may have many", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    createChat(db, c.id);
    createChat(db, c.id);
    createChat(db, c.id);

    expect(listChats(db, c.id)).toHaveLength(3);
  });

  test("an untitled thread takes its name from the first thing asked", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, c.id);

    appendMessage(db, chat.id, { role: "user", content: "Who runs the inn at Vess?\nAnd why?" });
    appendMessage(db, chat.id, { role: "user", content: "A later question" });

    expect(getChat(db, chat.id)?.title).toBe("Who runs the inn at Vess?");
  });

  test("a long first line is truncated rather than stored whole as a title", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, c.id);

    appendMessage(db, chat.id, { role: "user", content: "x".repeat(200) });

    const title = getChat(db, chat.id)?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
  });

  test("messages keep their order and their citations", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, c.id);

    appendMessage(db, chat.id, { role: "user", content: "who runs the inn?" });
    appendMessage(db, chat.id, {
      role: "assistant",
      content: "Vashti does.",
      citations: [
        {
          chunkId: 7,
          docId: 1,
          filename: "s12.md",
          headingPath: "Session 12 › Vess",
          snippet: "Vashti keeps the Ash & Anchor.",
        },
      ],
    });

    const messages = getChat(db, chat.id)?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.citations?.[0]?.filename).toBe("s12.md");
    expect(messages[0]?.citations).toBeNull();
  });

  test("assistant messages keep bounded tool provenance across reload", () => {
    const db = fresh();
    const campaign = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, campaign.id);
    const assistant = appendMessage(db, chat.id, {
      role: "assistant", content: "Grounded answer", citations: null,
      toolCalls: [{ name: "search_notes", args: { query: "gate" }, status: "completed", result: "[S1] crypt.md" }],
    });
    expect(assistant.toolCalls?.[0]).toMatchObject({ name: "search_notes", status: "completed" });
    expect(getChat(db, chat.id)?.messages[0]?.toolCalls?.[0]?.result).toContain("crypt.md");
  });

  test("a malformed citation list costs the footnotes, not the message", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, c.id);
    const m = appendMessage(db, chat.id, { role: "assistant", content: "Vashti does." });
    db.run("UPDATE messages SET citations = ? WHERE id = ?", ["{not json", m.id]);

    const back = getChat(db, chat.id)?.messages[0];
    expect(back?.content).toBe("Vashti does.");
    expect(back?.citations).toBeNull();
  });

  test("replacing a thread's messages wipes what was there", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, c.id);
    appendMessage(db, chat.id, { role: "user", content: "first" });

    const after = replaceMessages(db, chat.id, [
      { role: "user", content: "rebuilt" },
      { role: "assistant", content: "acknowledged" },
    ]);

    expect(after.map((m) => m.content)).toEqual(["rebuilt", "acknowledged"]);
    expect(getChat(db, chat.id)?.messageCount).toBe(2);
  });

  test("truncating drops the message at the index and everything after it", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, c.id);
    for (const content of ["one", "two", "three", "four"]) {
      appendMessage(db, chat.id, { role: "user", content });
    }

    expect(truncateMessagesFrom(db, chat.id, 2).map((m) => m.content)).toEqual(["one", "two"]);
    expect(truncateMessagesFrom(db, chat.id, 99).map((m) => m.content)).toEqual(["one", "two"]);
  });

  test("deleting a dungeon takes its Architect thread with it", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const d = createDungeon(db, c.id, { name: "Crypt" });
    const chat = architectChat(db, d.id);
    appendMessage(db, chat.id, { role: "user", content: "colder" });

    deleteDungeon(db, d.id);

    expect(getChat(db, chat.id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  test("deleting a thread reports whether it existed", () => {
    const db = fresh();
    const c = createCampaign(db, { name: "Ashen Vale" });
    const chat = createChat(db, c.id);
    expect(deleteChat(db, chat.id)).toBe(true);
    expect(deleteChat(db, chat.id)).toBe(false);
  });
});

// ─── migration ────────────────────────────────────────────────────────────────

/** The v1 schema, verbatim enough to reproduce what a pre-campaign file holds. */
const V1_SCHEMA = `
CREATE TABLE documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT    NOT NULL UNIQUE,
  uploaded_at  INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  summary      TEXT    NOT NULL DEFAULT '',
  entities     TEXT    NOT NULL DEFAULT '[]',
  tokens       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE chunks (
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
CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  text, heading_path, content = 'chunks', content_rowid = 'id',
  tokenize = 'porter unicode61'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text, heading_path)
  VALUES (new.id, new.text, new.heading_path);
END;
CREATE TABLE embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vec      BLOB    NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function writeV1Database(path: string): { docId: number; chunkCount: number } {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run(V1_SCHEMA);

  db.run(
    "INSERT INTO documents (filename, uploaded_at, content_hash, summary, entities, tokens) VALUES (?, ?, ?, ?, ?, ?)",
    ["session-12.md", 1700000000000, "abc123", "The party enters the sewers.", '["Vashti"]', 420],
  );
  const docId = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);

  const chunks = chunkDocument("# Session 12\n\nVashti led them through the tannery grate.\n");
  const insert = db.prepare(
    `INSERT INTO chunks (doc_id, ordinal, heading_path, text, tokens, start_offset, end_offset)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  for (const chunk of chunks) {
    const row = insert.get(
      docId,
      chunk.ordinal,
      chunk.headingPath,
      chunk.text,
      chunk.tokens,
      chunk.startOffset,
      chunk.endOffset,
    ) as { id: number };
    db.run("INSERT INTO embeddings (chunk_id, vec) VALUES (?, ?)", [
      row.id,
      new Uint8Array(Float32Array.from([0.1, 0.2, 0.3]).buffer),
    ]);
  }

  db.run("INSERT INTO meta (key, value) VALUES ('embedding_model', 'voyage-4-lite:1024')");
  db.close();
  return { docId, chunkCount: chunks.length };
}

describe("v1 → v2 migration", () => {
  test("existing notes are adopted by a campaign, keeping their ids and their index", () => {
    const path = tempDbPath();
    const { docId, chunkCount } = writeV1Database(path);

    const db = openAppDb(path);

    const campaigns = listCampaigns(db);
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.name).toBe(ADOPTED_CAMPAIGN_NAME);

    const campaignId = campaigns[0]!.id;
    const docs = listDocuments(db, campaignId);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(docId);
    expect(docs[0]?.filename).toBe("session-12.md");
    expect(docs[0]?.summary).toBe("The party enters the sewers.");
    expect(docs[0]?.entities).toEqual(["Vashti"]);
    expect(docs[0]?.chunkCount).toBe(chunkCount);

    // The whole point of the careful rebuild: chunks and embeddings survive.
    expect(db.query("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: chunkCount });
    expect(db.query("SELECT COUNT(*) AS n FROM embeddings").get()).toEqual({ n: chunkCount });
    expect(
      db.query("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'tannery'").get(),
    ).toEqual({ n: 1 });
    expect(getMeta(db, "embedding_model")).toBe("voyage-4-lite:1024");
    expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  test("the filename constraint becomes composite, so a second campaign may reuse it", () => {
    const path = tempDbPath();
    writeV1Database(path);
    const db = openAppDb(path);

    const second = createCampaign(db, { name: "Kestrel Reach" });
    expect(() =>
      replaceDocument(db, {
        campaignId: second.id,
        filename: "session-12.md",
        contentHash: "different",
        tokens: 10,
        chunks: chunkDocument("# Elsewhere\n\nA different campaign entirely.\n"),
      }),
    ).not.toThrow();

    expect(listDocuments(db, second.id)).toHaveLength(1);
    db.close();
  });

  test("re-opening an already migrated database changes nothing", () => {
    const path = tempDbPath();
    writeV1Database(path);

    openAppDb(path).close();
    const db = openAppDb(path);

    expect(listCampaigns(db)).toHaveLength(1);
    expect(listDocuments(db, listCampaigns(db)[0]!.id)).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM embeddings").get()).not.toEqual({ n: 0 });
    db.close();
  });

  test("an empty v1 database upgrades without inventing a campaign to hold nothing", () => {
    const path = tempDbPath();
    const v1 = new Database(path, { create: true });
    v1.run(V1_SCHEMA);
    v1.close();

    const db = openAppDb(path);

    expect(listCampaigns(db)).toEqual([]);
    expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
    // The rebuild still happened — the constraint is composite now.
    const created = createCampaign(db, { name: "Ashen Vale" });
    expect(() =>
      replaceDocument(db, {
        campaignId: created.id,
        filename: "a.md",
        contentHash: "h",
        tokens: 1,
        chunks: chunkDocument("# A\n\nText.\n"),
      }),
    ).not.toThrow();
    db.close();
  });

  test("a brand-new database is created at v2 with no campaign invented for it", () => {
    const path = tempDbPath();
    const db = openAppDb(path);

    expect(listCampaigns(db)).toEqual([]);
    expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
    db.close();
  });
});
