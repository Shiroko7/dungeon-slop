import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openAppDb } from "../db/open.ts";
import { SCHEMA } from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCampaign } from "./campaigns.ts";
import { createDungeon, getDungeon, deleteDungeon } from "./dungeons.ts";
import { commitDungeon } from "./mutations.ts";
import { geometry } from "../test-fixtures.ts";

function fixture() {
  const db = openAppDb(":memory:");
  const campaign = createCampaign(db, { name: "Scratch" });
  const dungeon = createDungeon(db, campaign.id, {
    name: "Original",
    geometry: geometry(),
  });
  return { db, dungeon };
}
test("two writers cannot silently overwrite the same revision", () => {
  const { db, dungeon } = fixture();
  try {
    expect(
      commitDungeon(db, dungeon.id, {
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
        patch: { name: "First writer" },
      }),
    ).toBe(1);
    expect(() =>
      commitDungeon(db, dungeon.id, {
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
        patch: { name: "Second writer" },
      }),
    ).toThrow("newer version");
    expect(getDungeon(db, dungeon.id)!.name).toBe("First writer");
  } finally {
    db.close();
  }
});
test("lost acknowledgement returns the original revision even after another commit", () => {
  const { db, dungeon } = fixture();
  try {
    const mutation = {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      patch: { name: "one" },
    };
    commitDungeon(db, dungeon.id, mutation);
    commitDungeon(db, dungeon.id, {
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
      patch: { name: "two" },
    });
    expect(commitDungeon(db, dungeon.id, mutation)).toBe(1);
    expect(getDungeon(db, dungeon.id)!.name).toBe("two");
    expect(() =>
      commitDungeon(db, dungeon.id, {
        ...mutation,
        patch: { name: "different" },
      }),
    ).toThrow("reused");
  } finally {
    db.close();
  }
});
test("a mutation changes fields and room notes atomically, rejecting unknown rooms", () => {
  const { db, dungeon } = fixture();
  try {
    expect(() =>
      commitDungeon(db, dungeon.id, {
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
        patch: { name: "wrong", roomNotes: [[999, { name: "orphan" }]] },
      }),
    ).toThrow("does not belong");
    expect(getDungeon(db, dungeon.id)!.name).toBe("Original");
    expect(getDungeon(db, dungeon.id)!.revision).toBe(0);
    commitDungeon(db, dungeon.id, {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      patch: { name: "new", roomNotes: [[0, { name: "room zero" }]] },
    });
    expect(getDungeon(db, dungeon.id)!.roomNotes).toEqual([
      [0, { name: "room zero" }],
    ]);
    expect(getDungeon(db, dungeon.id)!.revision).toBe(1);
  } finally {
    db.close();
  }
});
test("replaying a deleted owner's mutation cannot resurrect it", () => {
  const { db, dungeon } = fixture();
  try {
    const mutation = {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      patch: { name: "one" },
    };
    commitDungeon(db, dungeon.id, mutation);
    deleteDungeon(db, dungeon.id);
    expect(() => commitDungeon(db, dungeon.id, mutation)).toThrow(
      "no longer exists",
    );
    expect(db.query("SELECT * FROM dungeon_mutations").all()).toEqual([]);
  } finally {
    db.close();
  }
});
test("v4 migration preserves authored fields and adds revision zero idempotently", () => {
  const db = new Database(":memory:");
  try {
    db.run(SCHEMA.replace("  revision    INTEGER NOT NULL DEFAULT 0,\n", ""));
    db.run("INSERT INTO campaigns VALUES (1, 'Campaign', '', 0, 0)");
    db.run(
      "INSERT INTO dungeons (campaign_id, name, blueprint, created_at, updated_at) VALUES (1, 'Authored map', '{\"title\":\"Keep me\"}', 0, 0)",
    );
    db.run(
      "INSERT INTO room_notes VALUES (1, 0, 'Authored room', '{\"name\":\"Authored room\"}', 0)",
    );
    runMigrations(db);
    runMigrations(db);
    expect(getDungeon(db, 1)!.revision).toBe(0);
    expect(getDungeon(db, 1)!.name).toBe("Authored map");
    expect(getDungeon(db, 1)!.roomNotes[0]![1].name).toBe("Authored room");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
