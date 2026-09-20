import { test, expect } from "bun:test";
import {
  SaveCoordinator,
  browserRecoveryStorage,
  type PendingSave,
  type RecoveryStorage,
} from "./save-coordinator.ts";
import { ApiError } from "./api.ts";
import { deferred, dungeonRecord } from "../test-fixtures.ts";
import type { DungeonMutation } from "../campaign/types.ts";

function memory() {
  const records = new Map<string, PendingSave>();
  const storage: RecoveryStorage = {
    read: () => structuredClone([...records.values()]),
    put: (entry) => {
      records.set(entry.key, structuredClone(entry));
    },
    remove: (key) => {
      records.delete(key);
    },
  };
  return { storage, records };
}
function fixture(
  send: (
    id: number,
    mutation: DungeonMutation,
  ) => Promise<{ revision: number }>,
) {
  const { storage, records } = memory();
  const coordinator = new SaveCoordinator(
    storage,
    send,
    async (id) => dungeonRecord(id),
    60_000,
  );
  coordinator.attach(dungeonRecord());
  return { coordinator, storage, records };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("coalesces unsent name, geometry, overview and room edits by owner", async () => {
  const sent: DungeonMutation[] = [];
  const { coordinator, records } = fixture(async (_, m) => {
    sent.push(m);
    return { revision: 1 };
  });
  coordinator.queue(dungeonRecord(), {
    name: "old",
    roomNotes: [[0, { name: "old" }]],
  });
  coordinator.queue(dungeonRecord(), {
    name: "latest",
    roomNotes: [[0, { name: "latest" }]],
  });
  expect(coordinator.state(1).status).toBe("unsaved");
  expect(records.size).toBe(1);
  await coordinator.flush(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.patch).toEqual({
    name: "latest",
    roomNotes: [[0, { name: "latest" }]],
  });
  expect(records.size).toBe(0);
  expect(coordinator.state(1).status).toBe("saved");
});

test("serializes one owner and preserves edits arriving during the request", async () => {
  const first = deferred<{ revision: number }>();
  const sent: DungeonMutation[] = [];
  const { coordinator } = fixture(async (_, m) => {
    sent.push(structuredClone(m));
    return sent.length === 1 ? first.promise : { revision: 2 };
  });
  coordinator.queue(dungeonRecord(), { name: "first" });
  const saving = coordinator.flush(1);
  await tick();
  coordinator.queue(dungeonRecord(), { name: "second" });
  expect(sent).toHaveLength(1);
  expect(coordinator.flush(1)).toBe(saving);
  first.resolve({ revision: 1 });
  await saving;
  expect(sent.map((m) => [m.expectedRevision, m.patch.name])).toEqual([
    [0, "first"],
    [1, "second"],
  ]);
  expect(coordinator.state(1).status).toBe("saved");
});

test("failed acknowledgement retries exactly the same operation before newer edits", async () => {
  let failing = true;
  const sent: DungeonMutation[] = [];
  const { coordinator, records } = fixture(async (_, m) => {
    sent.push(structuredClone(m));
    if (failing) throw new Error("offline");
    return { revision: m.expectedRevision + 1 };
  });
  coordinator.queue(dungeonRecord(), { name: "first" });
  await coordinator.flush(1);
  expect(coordinator.state(1).status).toBe("failed");
  expect(records.size).toBe(1);
  coordinator.queue(dungeonRecord(), { name: "latest" });
  failing = false;
  await coordinator.flush(1);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2]!.patch.name).toBe("latest");
  expect(sent[2]!.expectedRevision).toBe(1);
});

test("different dungeons save independently", async () => {
  const held = deferred<{ revision: number }>();
  const { coordinator } = fixture(async (id) =>
    id === 1 ? held.promise : { revision: 1 },
  );
  coordinator.attach(dungeonRecord(2));
  coordinator.queue(dungeonRecord(1), { name: "A" });
  coordinator.queue(dungeonRecord(2), { name: "B" });
  const a = coordinator.flush(1);
  await coordinator.flush(2);
  expect(coordinator.state(2).status).toBe("saved");
  expect(coordinator.state(1).status).toBe("saving");
  held.resolve({ revision: 1 });
  await a;
});

test("reload recovery replays the original receipt, then later edits", async () => {
  const { coordinator, storage } = fixture(async () => {
    throw new Error("lost ack");
  });
  coordinator.queue(dungeonRecord(), { name: "before" });
  await coordinator.flush(1);
  coordinator.queue(dungeonRecord(), { name: "after" });
  const entry = storage.read()[0]!;
  const sent: DungeonMutation[] = [];
  const reloaded = new SaveCoordinator(
    storage,
    async (_, m) => {
      sent.push(m);
      return { revision: m.expectedRevision + 1 };
    },
    async () => ({ ...dungeonRecord(), revision: 1 }),
    60_000,
  );
  await reloaded.recover(entry);
  expect(sent[0]!.operationId).toBe(entry.flight!.operationId);
  expect(sent[1]!.patch.name).toBe("after");
  expect(storage.read()).toEqual([]);
});

test("pending recovery refuses a changed revision and never recreates a deleted owner", async () => {
  const { coordinator, storage } = fixture(async () => ({ revision: 1 }));
  coordinator.queue(dungeonRecord(), { name: "recover me" });
  const entry = storage.read()[0]!;
  let writes = 0;
  const reloaded = new SaveCoordinator(
    storage,
    async () => {
      writes++;
      return { revision: 3 };
    },
    async () => ({ ...dungeonRecord(), revision: 2 }),
    60_000,
  );
  await reloaded.recover(entry);
  expect(reloaded.state(1).status).toBe("conflict");
  expect(writes).toBe(0);
  await reloaded.flush(1);
  expect(writes).toBe(0);
  const deleted = new SaveCoordinator(
    storage,
    async () => {
      writes++;
      return { revision: 1 };
    },
    async () => {
      throw new ApiError("deleted", 404);
    },
  );
  await expect(deleted.recover(entry)).rejects.toThrow("deleted");
  expect(storage.read()).toHaveLength(1);
});

test("a server conflict retains edits and requires explicit rebase", async () => {
  let conflict = true;
  const { storage } = memory();
  const coordinator = new SaveCoordinator(
    storage,
    async (_, m) => {
      if (conflict)
        throw new ApiError("newer version", 409, "revision_conflict", 3);
      expect(m.expectedRevision).toBe(3);
      return { revision: 4 };
    },
    async () => ({ ...dungeonRecord(), revision: 3 }),
    60_000,
  );
  coordinator.attach(dungeonRecord());
  coordinator.queue(dungeonRecord(), { name: "mine" });
  await coordinator.flush(1);
  expect(coordinator.state(1).status).toBe("conflict");
  await expect(coordinator.keepLocal(1, 2)).rejects.toThrow("changed again");
  conflict = false;
  await coordinator.keepLocal(1, 3);
  expect(coordinator.state(1).status).toBe("saved");
});

test("storage denial remains visibly unsafe until server acknowledgement", async () => {
  const held = deferred<{ revision: number }>();
  const storage: RecoveryStorage = {
    read: () => [],
    put: () => {
      throw new Error("quota");
    },
    remove: () => {},
  };
  const coordinator = new SaveCoordinator(
    storage,
    async () => held.promise,
    async () => dungeonRecord(),
    60_000,
  );
  coordinator.attach(dungeonRecord());
  coordinator.queue(dungeonRecord(), { name: "mine" });
  expect(coordinator.hasUnsafeChanges()).toBe(true);
  const work = coordinator.flush(1);
  held.resolve({ revision: 1 });
  await work;
  expect(coordinator.hasUnsafeChanges()).toBe(false);
});

test("recovery refuses a copy locked by another tab", async () => {
  const { storage } = memory();
  storage.acquire = async () => null;
  const coordinator = new SaveCoordinator(
    storage,
    async () => ({ revision: 1 }),
    async () => dungeonRecord(),
  );
  await expect(
    coordinator.recover({
      key: "x",
      dungeonId: 1,
      campaignId: 1,
      name: "A",
      revision: 0,
      pending: { name: "mine" },
      flight: null,
    }),
  ).rejects.toThrow("another tab");
});

test("local edits during conflict reload cannot be discarded by a late read", async () => {
  const read = deferred<ReturnType<typeof dungeonRecord>>();
  const { storage } = memory();
  const coordinator = new SaveCoordinator(
    storage,
    async () => {
      throw new ApiError("conflict", 409);
    },
    async () => read.promise,
    60_000,
  );
  coordinator.attach(dungeonRecord());
  coordinator.queue(dungeonRecord(), { name: "one" });
  await coordinator.flush(1);
  const reload = coordinator.reload(1);
  await tick();
  coordinator.queue(dungeonRecord(), { name: "two" });
  read.resolve(dungeonRecord());
  await expect(reload).rejects.toThrow("Local edits changed");
  expect(coordinator.pendingEntries()[0]!.pending.name).toBe("two");
});

test("browser recovery budget rejects overflow without evicting older work", () => {
  const values = new Map<string, string>();
  const storage = browserRecoveryStorage({
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
    clear: () => values.clear(),
  });
  const entry: PendingSave = {
    key: "dungeon-outbox-v1:a",
    dungeonId: 1,
    campaignId: 1,
    name: "A",
    revision: 0,
    pending: { name: "mine" },
    flight: null,
  };
  storage.put(entry);
  expect(() =>
    storage.put({
      ...entry,
      key: "dungeon-outbox-v1:b",
      name: "x".repeat(3 * 1024 * 1024),
    }),
  ).toThrow("full");
  expect(storage.read()).toEqual([entry]);
});
