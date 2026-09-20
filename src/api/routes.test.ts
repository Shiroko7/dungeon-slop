import { geometry } from "../test-fixtures.ts";
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The database path is read when `db/open.ts` is first evaluated, so it has to
// be set before anything imports it — hence the dynamic import below.
const dir = mkdtempSync(join(tmpdir(), "dungeon-slop-routes-"));
process.env.NOTES_DB_PATH = join(dir, "routes.sqlite");

const { handleApiRoute } = await import("./routes.ts");
const { closeAppDb } = await import("../db/context.ts");

afterAll(() => {
  closeAppDb();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS */
  }
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await handleApiRoute(
    new Request(`http://localhost${path}`, init),
    path,
  );
  if (res === null) return { status: 404, body: null };
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

// ─── routing ──────────────────────────────────────────────────────────────────

describe("route matching", () => {
  test("an unknown path falls through so the caller can serve the app", async () => {
    expect(
      await handleApiRoute(
        new Request("http://localhost/whatever"),
        "/whatever",
      ),
    ).toBeNull();
    const missing = await handleApiRoute(
      new Request("http://localhost/api/nope"),
      "/api/nope",
    );
    expect(missing).toBeNull();
  });

  test("a known path under the wrong verb answers 405, not 404", async () => {
    const res = await call("PUT", "/api/campaigns");
    expect(res.status).toBe(405);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  test("a non-numeric id does not match a numeric route", async () => {
    expect(
      await handleApiRoute(
        new Request("http://localhost/api/campaigns/abc"),
        "/api/campaigns/abc",
      ),
    ).toBeNull();
  });

  test("health answers without touching the database", async () => {
    expect((await call("GET", "/api/health")).body).toEqual({ status: "ok" });
  });

  test("authored replacements checkpoint and restore without losing revisions", async () => {
    const campaign = (await call("POST", "/api/campaigns", { name: "History" })).body.campaign;
    const dungeon = (await call("POST", `/api/campaigns/${campaign.id}/dungeons`, {
      name: "Versioned",
      geometry: geometry([1]),
      overview: { history: "old", corridorFeatures: [], wanderingMonsters: [] },
    })).body.dungeon;
    const first = {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      patch: { overview: { history: "new", corridorFeatures: [], wanderingMonsters: [] } },
    };
    expect((await call("PATCH", `/api/dungeons/${dungeon.id}`, first)).status).toBe(200);
    const revisions = await call("GET", `/api/dungeons/${dungeon.id}/revisions`);
    expect(revisions.body.revisions).toHaveLength(1);
    const restore = await call("POST", `/api/dungeons/${dungeon.id}/revisions/${revisions.body.revisions[0].id}/restore`, {
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
    });
    expect(restore.status).toBe(200);
    expect(restore.body.dungeon.overview.history).toBe("old");
    expect(restore.body.revision).toBe(2);
  });

  test("fork operation IDs make an ambiguous retry return the same sibling", async () => {
    const campaign = (await call("POST", "/api/campaigns", { name: "Fork receipts" })).body.campaign;
    const dungeon = (await call("POST", `/api/campaigns/${campaign.id}/dungeons`, {
      name: "Parent", geometry: geometry([1]),
    })).body.dungeon;
    const operationId = crypto.randomUUID();
    const body = { expectedRevision: 0, operationId, seed: 9, geometry: geometry([2]) };
    const first = await call("POST", `/api/dungeons/${dungeon.id}/fork`, body);
    const second = await call("POST", `/api/dungeons/${dungeon.id}/fork`, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.dungeon.id).toBe(first.body.dungeon.id);
    expect((await call("GET", `/api/campaigns/${campaign.id}/dungeons`)).body.dungeons).toHaveLength(2);
  });
});

// ─── the ownership tree, over HTTP ────────────────────────────────────────────

describe("campaign lifecycle over the API", () => {
  test("create, read, list, rename", async () => {
    const created = await call("POST", "/api/campaigns", {
      name: "Ashen Vale",
      blurb: "ash and salt",
    });
    expect(created.status).toBe(201);
    const id = created.body.campaign.id as number;

    expect((await call("GET", `/api/campaigns/${id}`)).body.campaign.name).toBe(
      "Ashen Vale",
    );
    expect(
      (await call("GET", "/api/campaigns")).body.campaigns.length,
    ).toBeGreaterThan(0);

    const renamed = await call("PATCH", `/api/campaigns/${id}`, {
      name: "The Ashen Vale",
    });
    expect(renamed.body.campaign.name).toBe("The Ashen Vale");
    expect(renamed.body.campaign.blurb).toBe("ash and salt");
  });

  test("a nameless campaign is a bad request, not a 500", async () => {
    expect((await call("POST", "/api/campaigns", { name: "   " })).status).toBe(
      400,
    );
    expect((await call("POST", "/api/campaigns", {})).status).toBe(400);
  });

  test("reading a campaign that does not exist is a 404", async () => {
    expect((await call("GET", "/api/campaigns/99999")).status).toBe(404);
  });

  test("dungeons and chats are reached through their campaign", async () => {
    const campaign = (
      await call("POST", "/api/campaigns", { name: "Kestrel Reach" })
    ).body.campaign;

    const dungeon = await call(
      "POST",
      `/api/campaigns/${campaign.id}/dungeons`,
      {
        name: "Crypt of Vess",
        geometry: geometry([1, 2, 3]),
      },
    );
    expect(dungeon.status).toBe(201);
    expect(dungeon.body.dungeon.roomCount).toBe(3);

    const chat = await call("POST", `/api/campaigns/${campaign.id}/chats`, {
      title: "lore",
    });
    expect(chat.status).toBe(201);

    expect(
      (await call("GET", `/api/campaigns/${campaign.id}/dungeons`)).body
        .dungeons,
    ).toHaveLength(1);
    expect(
      (await call("GET", `/api/campaigns/${campaign.id}/chats`)).body.chats,
    ).toHaveLength(1);
    expect(
      (await call("GET", `/api/campaigns/${campaign.id}/notes`)).body.count,
    ).toBe(0);
  });

  test("a dungeon under a missing campaign is a 404, not an orphan", async () => {
    expect(
      (await call("POST", "/api/campaigns/99999/dungeons", { name: "Ghost" }))
        .status,
    ).toBe(404);
    expect((await call("GET", "/api/campaigns/99999/chats")).status).toBe(404);
    expect((await call("GET", "/api/campaigns/99999/notes")).status).toBe(404);
  });

  test("deleting a campaign takes its dungeons and chats with it", async () => {
    const campaign = (await call("POST", "/api/campaigns", { name: "Doomed" }))
      .body.campaign;
    const dungeon = (
      await call("POST", `/api/campaigns/${campaign.id}/dungeons`, {
        name: "Crypt",
      })
    ).body.dungeon;
    const chat = (await call("POST", `/api/campaigns/${campaign.id}/chats`, {}))
      .body.chat;

    expect(
      (await call("DELETE", `/api/campaigns/${campaign.id}`)).body.deleted,
    ).toBe(campaign.id);

    expect((await call("GET", `/api/dungeons/${dungeon.id}`)).status).toBe(404);
    expect((await call("GET", `/api/chats/${chat.id}`)).status).toBe(404);
    expect((await call("DELETE", `/api/campaigns/${campaign.id}`)).status).toBe(
      404,
    );
  });
});

describe("dungeon routes", () => {
  async function newCampaign(name: string): Promise<number> {
    return (await call("POST", "/api/campaigns", { name })).body.campaign
      .id as number;
  }

  test("a patch saves only what it sends", async () => {
    const campaignId = await newCampaign("Patch Test");
    const dungeon = (
      await call("POST", `/api/campaigns/${campaignId}/dungeons`, {
        name: "Crypt",
        seed: 42,
        geometry: geometry([1]),
      })
    ).body.dungeon;

    const patched = await call("PATCH", `/api/dungeons/${dungeon.id}`, {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      patch: { geometry: geometry([1, 2]) },
    });

    expect(patched.body.dungeon.roomCount).toBe(2);
    expect(patched.body.dungeon.name).toBe("Crypt");
    expect(patched.body.dungeon.seed).toBe(42);
  });

  test("a fork is a sibling that leaves the original intact", async () => {
    const campaignId = await newCampaign("Fork Test");
    const original = (
      await call("POST", `/api/campaigns/${campaignId}/dungeons`, {
        name: "Crypt of Vess",
        geometry: geometry([1, 2]),
      })
    ).body.dungeon;

    await call("PUT", `/api/dungeons/${original.id}/rooms/1`, {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      description: { name: "Entry Hall", features: "Cold." },
    });

    const fork = await call("POST", `/api/dungeons/${original.id}/fork`, {
      expectedRevision: 1,
      seed: 7,
      geometry: geometry([1]),
    });

    expect(fork.status).toBe(201);
    expect(fork.body.dungeon.name).toBe("Crypt of Vess (2)");
    expect(fork.body.dungeon.parentId).toBe(original.id);
    expect(fork.body.dungeon.describedCount).toBe(0);

    const kept = await call("GET", `/api/dungeons/${original.id}`);
    expect(kept.body.dungeon.roomCount).toBe(2);
    expect(kept.body.dungeon.roomNotes).toEqual([
      [1, { name: "Entry Hall", features: "Cold." }],
    ]);
  });

  test("room notes round-trip and can be removed", async () => {
    const campaignId = await newCampaign("Room Notes");
    const dungeon = (
      await call("POST", `/api/campaigns/${campaignId}/dungeons`, {
        name: "Crypt",
        geometry: geometry([1, 2]),
      })
    ).body.dungeon;

    await call("PUT", `/api/dungeons/${dungeon.id}/rooms/2`, {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      description: { name: "Cistern", features: "Black water." },
    });
    expect(
      (await call("GET", `/api/dungeons/${dungeon.id}`)).body.dungeon
        .describedCount,
    ).toBe(1);

    await call("DELETE", `/api/dungeons/${dungeon.id}/rooms/2`, {
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
    });
    expect(
      (await call("GET", `/api/dungeons/${dungeon.id}`)).body.dungeon.roomNotes,
    ).toEqual([]);
  });

  test("a room note without a description is a bad request", async () => {
    const campaignId = await newCampaign("Bad Note");
    const dungeon = (
      await call("POST", `/api/campaigns/${campaignId}/dungeons`, {
        name: "Crypt",
      })
    ).body.dungeon;

    expect(
      (await call("PUT", `/api/dungeons/${dungeon.id}/rooms/1`, {})).status,
    ).toBe(400);
    expect(
      (await call("PUT", "/api/dungeons/99999/rooms/1", { description: {} }))
        .status,
    ).toBe(404);
  });

  test("the Architect thread is created on first ask and reused after", async () => {
    const campaignId = await newCampaign("Architect");
    const dungeon = (
      await call("POST", `/api/campaigns/${campaignId}/dungeons`, {
        name: "Crypt",
      })
    ).body.dungeon;

    const first = await call("POST", `/api/dungeons/${dungeon.id}/chat`, {});
    const second = await call("POST", `/api/dungeons/${dungeon.id}/chat`, {});

    expect(first.body.chat.id).toBe(second.body.chat.id);
    expect(first.body.chat.dungeonId).toBe(dungeon.id);
    // It is a build log, not a Loremaster thread, so it stays out of that list.
    expect(
      (await call("GET", `/api/campaigns/${campaignId}/chats`)).body.chats,
    ).toEqual([]);
  });
});

describe("chat routes", () => {
  test("messages append, title themselves, and truncate", async () => {
    const campaignId = (
      await call("POST", "/api/campaigns", { name: "Chatty" })
    ).body.campaign.id;
    const chat = (await call("POST", `/api/campaigns/${campaignId}/chats`, {}))
      .body.chat;

    await call("POST", `/api/chats/${chat.id}/messages`, {
      role: "user",
      content: "Who runs the inn at Vess?",
    });
    await call("POST", `/api/chats/${chat.id}/messages`, {
      role: "assistant",
      content: "Vashti does.",
      citations: [
        {
          chunkId: 1,
          docId: 1,
          filename: "s12.md",
          headingPath: "Session 12",
          snippet: "Vashti keeps the Ash & Anchor.",
        },
      ],
    });

    const loaded = (await call("GET", `/api/chats/${chat.id}`)).body.chat;
    expect(loaded.title).toBe("Who runs the inn at Vess?");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1].citations[0].filename).toBe("s12.md");

    const truncated = await call("DELETE", `/api/chats/${chat.id}/messages/1`);
    expect(truncated.body.messages).toHaveLength(1);
  });

  test("a whole transcript can be replaced in one call", async () => {
    const campaignId = (
      await call("POST", "/api/campaigns", { name: "Replace" })
    ).body.campaign.id;
    const chat = (await call("POST", `/api/campaigns/${campaignId}/chats`, {}))
      .body.chat;

    await call("POST", `/api/chats/${chat.id}/messages`, {
      role: "user",
      content: "first",
    });
    const replaced = await call("POST", `/api/chats/${chat.id}/messages`, {
      messages: [
        { role: "user", content: "rebuilt" },
        { role: "assistant", content: "acknowledged" },
      ],
    });

    expect(
      replaced.body.messages.map((m: { content: string }) => m.content),
    ).toEqual(["rebuilt", "acknowledged"]);
  });

  test("a message with no usable role is rejected", async () => {
    const campaignId = (
      await call("POST", "/api/campaigns", { name: "Bad Role" })
    ).body.campaign.id;
    const chat = (await call("POST", `/api/campaigns/${campaignId}/chats`, {}))
      .body.chat;

    expect(
      (
        await call("POST", `/api/chats/${chat.id}/messages`, {
          role: "system",
          content: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/chats/99999/messages", {
          role: "user",
          content: "x",
        })
      ).status,
    ).toBe(404);
  });
});

describe("legacy import", () => {
  test("reports its own status and runs exactly once", async () => {
    const before = await call("GET", "/api/legacy-import");
    expect(before.body.done).toBe(false);

    const first = await call("POST", "/api/legacy-import", {
      current: {
        config: null,
        dungeon: { rooms: [{ id: 1 }, { id: 2 }], corridors: [] },
        roomDescriptions: [[1, { name: "Entry Hall" }]],
        conversationHistory: [{ role: "user", content: "a damp crypt" }],
        label: "a damp crypt",
      },
      history: [
        {
          config: null,
          dungeon: { rooms: [{ id: 9 }], corridors: [] },
          label: "an older map",
        },
        // Same geometry as `current` — history recorded it at generation time,
        // so importing both would duplicate the live map.
        {
          config: null,
          dungeon: { rooms: [{ id: 1 }, { id: 2 }], corridors: [] },
          label: "dupe",
        },
      ],
    });

    expect(first.body.imported).toBe(2);
    expect(first.body.currentDungeonId).toBeGreaterThan(0);

    const after = await call("GET", "/api/legacy-import");
    expect(after.body.done).toBe(true);

    const second = await call("POST", "/api/legacy-import", {
      current: null,
      history: [],
    });
    expect(second.body.skipped).toBe(true);
  });
});

describe("M1 ownership and validation boundaries", () => {
  test("mutations require a revision and reject malformed payloads", async () => {
    const campaign = (
      await call("POST", "/api/campaigns", { name: "Validation" })
    ).body.campaign;
    const dungeon = (
      await call("POST", `/api/campaigns/${campaign.id}/dungeons`, {
        name: "Map",
        geometry: geometry([0]),
      })
    ).body.dungeon;
    for (const body of [
      null,
      [],
      "bad",
      { name: "blind overwrite" },
      {
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
        patch: { name: [] },
      },
    ]) {
      expect(
        (await call("PATCH", `/api/dungeons/${dungeon.id}`, body)).status,
      ).toBe(400);
    }
    const save = {
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      patch: { name: "writer one" },
    };
    expect(
      (await call("PATCH", `/api/dungeons/${dungeon.id}`, save)).status,
    ).toBe(200);
    expect(
      (await call("PATCH", `/api/dungeons/${dungeon.id}`, save)).body.revision,
    ).toBe(1);
    const conflict = await call("PATCH", `/api/dungeons/${dungeon.id}`, {
      ...save,
      operationId: crypto.randomUUID(),
      patch: { name: "writer two" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("revision_conflict");
    const wrongRoom = await call("PATCH", `/api/dungeons/${dungeon.id}`, {
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
      patch: { roomNotes: [[999, { name: "orphan" }]] },
    });
    expect(wrongRoom.status).toBe(400);
  });
  test("misowned AI requests fail before touching a provider", async () => {
    const a = (await call("POST", "/api/campaigns", { name: "Owner A" })).body
      .campaign;
    const b = (await call("POST", "/api/campaigns", { name: "Owner B" })).body
      .campaign;
    const dungeon = (
      await call("POST", `/api/campaigns/${a.id}/dungeons`, { name: "A" })
    ).body.dungeon;
    const chat = (await call("POST", `/api/campaigns/${b.id}/chats`, {})).body
      .chat;
    expect(
      (
        await call("POST", "/api/generate-config", {
          prompt: "x",
          campaignId: b.id,
          dungeonId: dungeon.id,
          expectedRevision: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/generate-config", {
          prompt: "x",
          campaignId: a.id,
          dungeonId: dungeon.id,
          chatId: chat.id,
          expectedRevision: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/generate-config", {
          prompt: "x",
          campaignId: a.id,
          dungeonId: dungeon.id,
          expectedRevision: 4,
        })
      ).status,
    ).toBe(409);
    expect((await call("POST", "/api/generate-config", null)).status).toBe(400);
  });
  test("browser origins and rebinding hosts are rejected, known local origins work", async () => {
    for (const origin of [
      "https://evil.example",
      "null",
      "http://localhost:9999",
    ]) {
      const request = new Request("http://localhost:3000/api/campaigns", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Must not be written" }),
      });
      expect((await handleApiRoute(request, "/api/campaigns"))!.status).toBe(
        403,
      );
    }
    const valid = new Request("http://127.0.0.1:3000/api/campaigns", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Local frontend" }),
    });
    expect((await handleApiRoute(valid, "/api/campaigns"))!.status).toBe(201);
    expect(
      (await handleApiRoute(
        new Request("http://evil.example:3000/api/campaigns"),
        "/api/campaigns",
      ))!.status,
    ).toBe(403);
  });
});
