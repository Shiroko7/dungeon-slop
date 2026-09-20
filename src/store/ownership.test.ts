import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { api } from "./api.ts";
import {
  useDungeonStore,
  flushDungeonSave,
  dungeonOperations,
} from "./dungeon-store.ts";
import { useChatStore } from "./chat-store.ts";
import { useCampaignStore } from "./campaign-store.ts";
import { useNotesStore } from "./notes-store.ts";
import { deferred, dungeonRecord } from "../test-fixtures.ts";
import type { ChatRecord, Campaign } from "../campaign/types.ts";
import type { NoteDocument } from "../notes/types.ts";
import { runArchitect } from "../components/views/useArchitect.ts";
import { useAIStore } from "./ai-store.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";

function fakeFetch(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(handler, { preconnect: () => {} }),
  );
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function campaign(id: number): Campaign {
  return {
    id,
    name: `Campaign ${id}`,
    blurb: "",
    createdAt: 0,
    updatedAt: 0,
    dungeonCount: 0,
    chatCount: 0,
    noteCount: 0,
  };
}
function chat(id: number): ChatRecord {
  return {
    id,
    campaignId: 1,
    dungeonId: id,
    title: "",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    messages: [],
  };
}
afterEach(async () => {
  spyOn(api.dungeons, "update").mockImplementation(async (_, m) => ({
    revision: m.expectedRevision + 1,
  }));
  await flushDungeonSave();
  useDungeonStore.getState().closeDungeon();
  useChatStore.getState().close();
  useCampaignStore.getState().clearActive();
  useNotesStore.getState().close();
  mock.restore();
});

test("reversed dungeon loads and a closed pending load cannot reopen an old owner", async () => {
  const a = deferred<ReturnType<typeof dungeonRecord>>();
  const b = deferred<ReturnType<typeof dungeonRecord>>();
  spyOn(api.dungeons, "get").mockImplementation((id) =>
    id === 101 ? a.promise : b.promise,
  );
  const first = useDungeonStore.getState().loadDungeon(101);
  const second = useDungeonStore.getState().loadDungeon(102);
  b.resolve(dungeonRecord(102));
  await second;
  a.resolve(dungeonRecord(101));
  await first;
  expect(useDungeonStore.getState().dungeonId).toBe(102);
  expect(useDungeonStore.getState().name).toBe("Dungeon 102");
  const pending = deferred<ReturnType<typeof dungeonRecord>>();
  spyOn(api.dungeons, "get").mockImplementation(() => pending.promise);
  const load = useDungeonStore.getState().loadDungeon(103);
  useDungeonStore.getState().closeDungeon();
  pending.resolve(dungeonRecord(103));
  await load;
  expect(useDungeonStore.getState().dungeonId).toBeNull();
  expect(useDungeonStore.getState().dungeon).toBeNull();
});
test("campaign latest route wins, including stale refreshes", async () => {
  const a = deferred<Campaign>();
  const b = deferred<Campaign>();
  spyOn(api.campaigns, "get").mockImplementation((id) =>
    id === 1 ? a.promise : b.promise,
  );
  spyOn(api.dungeons, "list").mockResolvedValue([]);
  spyOn(api.chats, "list").mockResolvedValue([]);
  const first = useCampaignStore.getState().openCampaign(1);
  const second = useCampaignStore.getState().openCampaign(2);
  b.resolve(campaign(2));
  await second;
  a.resolve(campaign(1));
  await first;
  expect(useCampaignStore.getState().active?.id).toBe(2);
  await useCampaignStore.getState().refreshContents(1);
  expect(useCampaignStore.getState().active?.id).toBe(2);
});
test("reversed chat loads and late assistant writes cannot alter the new thread", async () => {
  const a = deferred<ChatRecord>();
  const b = deferred<ChatRecord>();
  spyOn(api.chats, "get").mockImplementation((id) =>
    id === 1 ? a.promise : b.promise,
  );
  const first = useChatStore.getState().openChat(1);
  const second = useChatStore.getState().openChat(2);
  b.resolve(chat(2));
  await second;
  a.resolve(chat(1));
  await first;
  expect(useChatStore.getState().chat?.id).toBe(2);
  const saved = deferred<any>();
  const append = spyOn(api.chats, "append").mockImplementation(
    () => saved.promise,
  );
  const reply = useChatStore.getState().recordAssistant("A reply");
  useChatStore.getState().close();
  await useChatStore.getState().openChat(1);
  saved.resolve({
    id: 99,
    role: "assistant",
    content: "A reply",
    citations: null,
    createdAt: 0,
  });
  await reply;
  expect(append.mock.calls[0]![0]).toBe(2);
  expect(useChatStore.getState().chat?.messages).toEqual([]);
});
test("late note loads and upload errors stay with their campaign", async () => {
  const a = deferred<NoteDocument[]>();
  const b = deferred<NoteDocument[]>();
  spyOn(api.notes, "list").mockImplementation((id) =>
    id === 1 ? a.promise : b.promise,
  );
  const first = useNotesStore.getState().fetchDocuments(1);
  const second = useNotesStore.getState().fetchDocuments(2);
  b.resolve([]);
  await second;
  a.resolve([{ id: 1, filename: "A" } as NoteDocument]);
  await first;
  expect(useNotesStore.getState().campaignId).toBe(2);
  expect(useNotesStore.getState().documents).toEqual([]);
  const response = deferred<Response>();
  fakeFetch(() => response.promise);
  const upload = useNotesStore
    .getState()
    .uploadFiles(2, [new File(["notes"], "scratch.md")]);
  await useNotesStore.getState().fetchDocuments(1);
  response.resolve(
    new Response(JSON.stringify({ error: "A late failure" }), { status: 500 }),
  );
  await upload;
  expect(useNotesStore.getState().campaignId).toBe(1);
  expect(useNotesStore.getState().error).toBeNull();
  expect(useNotesStore.getState().isUploading).toBe(false);
});
test("a delayed description for A cannot write to B even when transport ignores abort", async () => {
  spyOn(api.dungeons, "get").mockImplementation(async (id) =>
    dungeonRecord(id),
  );
  await useDungeonStore.getState().loadDungeon(201);
  const response = deferred<Response>();
  let signal: AbortSignal | undefined;
  fakeFetch(async (_, init) => {
    signal = init?.signal as AbortSignal;
    return response.promise;
  });
  const writing = spyOn(api.dungeons, "update").mockImplementation(
    async (_, m) => ({ revision: m.expectedRevision + 1 }),
  );
  const describe = useDungeonStore.getState().describeRoom(0);
  await tick();
  await useDungeonStore.getState().loadDungeon(202);
  response.resolve(
    new Response('data: {"description":{"name":"Belongs to A"}}\n\n'),
  );
  await describe;
  expect(signal!.aborted).toBe(true);
  expect(useDungeonStore.getState().dungeonId).toBe(202);
  expect(useDungeonStore.getState().roomDescriptions.size).toBe(0);
  expect(useDungeonStore.getState().error).toBeNull();
  expect(useDungeonStore.getState().isDescribingRooms).toBe(false);
  expect(writing).not.toHaveBeenCalled();
});
test("manual edits invalidate an older description on the same owner", async () => {
  spyOn(api.dungeons, "get").mockImplementation(async (id) =>
    dungeonRecord(id),
  );
  await useDungeonStore.getState().loadDungeon(301);
  const response = deferred<Response>();
  fakeFetch(() => response.promise);
  const describe = useDungeonStore.getState().describeRoom(0);
  await tick();
  useDungeonStore.getState().setRoomDescription(0, { name: "Handwritten" });
  response.resolve(
    new Response('data: {"description":{"name":"Old generated text"}}\n\n'),
  );
  await describe;
  expect(useDungeonStore.getState().roomDescriptions.get(0)?.name).toBe(
    "Handwritten",
  );
});
test("cancelled blueprint request cannot restore busy or error state", async () => {
  spyOn(api.dungeons, "get").mockImplementation(async (id) =>
    dungeonRecord(id),
  );
  await useDungeonStore.getState().loadDungeon(401);
  const response = deferred<Response>();
  fakeFetch(() => response.promise);
  const generate = useDungeonStore.getState().generateBlueprint("scratch");
  await tick();
  dungeonOperations.cancel();
  response.resolve(new Response('data: {"error":"old error"}\n\n'));
  await generate;
  expect(useDungeonStore.getState().isGeneratingBlueprint).toBe(false);
  expect(useDungeonStore.getState().error).toBeNull();
});

test("Architect owns config and blueprint as one cancellable turn", async () => {
  spyOn(api.dungeons, "get").mockImplementation(async (id) =>
    dungeonRecord(id),
  );
  spyOn(api.dungeons, "update").mockImplementation(async (_, m) => ({
    revision: m.expectedRevision + 1,
  }));
  spyOn(api.chats, "append").mockImplementation(async (_, message) => ({
    ...message,
    id: 1,
    createdAt: 0,
    citations: null,
  }));
  await useDungeonStore.getState().loadDungeon(501);
  useChatStore.setState({ chat: chat(501) });
  useAIStore.setState({ useBlueprint: true });
  const blueprint = deferred<Response>();
  const called = deferred<void>();
  let blueprintSignal: AbortSignal | undefined;
  fakeFetch(async (path, init) => {
    if (String(path).endsWith("generate-config"))
      return new Response(
        `data: ${JSON.stringify({ type: "config", config: DEFAULT_CONFIG })}\n\n`,
      );
    blueprintSignal = init?.signal as AbortSignal;
    called.resolve();
    return blueprint.promise;
  });
  const turn = runArchitect("A scratch crypt");
  await called.promise;
  expect(useDungeonStore.getState().isGeneratingConfig).toBe(true);
  expect(useDungeonStore.getState().isGeneratingBlueprint).toBe(true);
  const messageCount = useChatStore.getState().chat!.messages.length;
  await runArchitect("Should not start a second turn");
  expect(useChatStore.getState().chat!.messages).toHaveLength(messageCount);
  dungeonOperations.cancel();
  expect(blueprintSignal!.aborted).toBe(true);
  blueprint.resolve(new Response('data: {"error":"late failure"}\n\n'));
  await turn;
  expect(useDungeonStore.getState().isGeneratingConfig).toBe(false);
  expect(useDungeonStore.getState().error).toBeNull();
});

test("Architect cancellation during config cannot write a config or append to another chat", async () => {
  spyOn(api.dungeons, "get").mockImplementation(async (id) =>
    dungeonRecord(id),
  );
  spyOn(api.chats, "append").mockImplementation(async (_, message) => ({
    ...message,
    id: 1,
    createdAt: 0,
    citations: null,
  }));
  await useDungeonStore.getState().loadDungeon(601);
  useChatStore.setState({ chat: chat(601) });
  const config = deferred<Response>();
  const called = deferred<void>();
  fakeFetch(async () => {
    called.resolve();
    return config.promise;
  });
  const turn = runArchitect("scratch");
  await called.promise;
  await useDungeonStore.getState().loadDungeon(602);
  useChatStore.getState().close();
  useChatStore.setState({ chat: chat(602) });
  config.resolve(
    new Response(
      `data: ${JSON.stringify({ type: "config", config: { ...DEFAULT_CONFIG, theme_description: "late config" } })}\n\n`,
    ),
  );
  await turn;
  expect(useDungeonStore.getState().config?.theme_description).toBe(
    DEFAULT_CONFIG.theme_description,
  );
  expect(useChatStore.getState().chat!.messages).toEqual([]);
  expect(useDungeonStore.getState().error).toBeNull();
});
