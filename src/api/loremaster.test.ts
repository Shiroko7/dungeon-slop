import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as context from "../db/context.ts";
import * as registry from "../ai/provider-registry.ts";
import * as notesContext from "../notes/context.ts";
import { createCampaign } from "../campaign/campaigns.ts";
import { createChat, getChat } from "../campaign/chats.ts";
import { openNotesDb } from "../notes/db.ts";
import { ingestDocument } from "../notes/ingest.ts";
import type { AIProvider } from "../ai/types.ts";
import type { EmbeddingProvider } from "../notes/types.ts";
import { handleAskLoremaster } from "./loremaster.ts";

let db: Database;
const embedder: EmbeddingProvider = { model: "api-agent", embed: async (texts) => texts.map(() => Float32Array.from([1, 2, 3])) };
function fixtureProvider(): AIProvider {
  let calls = 0;
  return { name: "ollama", defaultModel: "fixture", models: [],
    complete: async () => ({ content: calls++ === 0 ? JSON.stringify({ tool: "search_notes", args: { query: "gate" } }) : JSON.stringify({ answer: "The gate is below Vess.", sources: ["S1"] }), usage: { inputTokens: 5, outputTokens: 4 }, model: "fixture" }),
    async *streamComplete() { const content = "The gate is below Vess. [S1]"; yield content; return { content, usage: { inputTokens: 5, outputTokens: 4 }, model: "fixture" }; },
  };
}
beforeEach(async () => {
  db = openNotesDb(":memory:"); createCampaign(db, { name: "Loremaster" });
  await ingestDocument(db, embedder, { name: "test", model: "test", summarize: async () => ({ summary: "Fixture", entities: [] }) },
    { campaignId: 1, filename: "crypt.md", content: "# Vess\n\nThe gate is below Vess." });
  spyOn(context, "appDb").mockImplementation(() => db);
  spyOn(notesContext, "notesEmbedder").mockImplementation(() => embedder);
  spyOn(registry, "getProvider").mockImplementation(() => fixtureProvider());
  spyOn(registry, "getApiKey").mockReturnValue("");
});
afterEach(() => { mock.restore(); db.close(); });
async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
async function ask(chatId: number, body: unknown) {
  const path = `/api/campaigns/1/chats/${chatId}/ask`;
  return handleAskLoremaster(new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), 1, chatId);
}

test("Loremaster streams research, answer tokens and persisted provenance", async () => {
  const chat = createChat(db, 1);
  const response = await ask(chat.id, { question: "Where is the gate?", provider: "ollama", model: "fixture" });
  expect(response?.headers.get("content-type")).toContain("text/event-stream");
  const output = await events(response!);
  expect(output.some((event) => event.type === "tool_start")).toBe(true);
  expect(output.some((event) => event.type === "token")).toBe(true);
  expect(output.some((event) => event.type === "complete")).toBe(true);
  expect(getChat(db, chat.id)?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(getChat(db, chat.id)?.messages[1]).toMatchObject({ content: "The gate is below Vess.", citations: [{ filename: "crypt.md", revision: 1 }] });
  expect(getChat(db, chat.id)?.messages[1]?.toolCalls?.[0]?.name).toBe("search_notes");
});

test("Loremaster cannot answer an Architect chat or another campaign", async () => {
  const architect = db.run("INSERT INTO dungeons (campaign_id, name, created_at, updated_at) VALUES (1, 'Map', 1, 1)");
  const dungeonId = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  db.run("INSERT INTO chats (campaign_id, dungeon_id, title, created_at, updated_at) VALUES (1, ?, 'Architect', 1, 1)", [dungeonId]);
  const architectChat = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  expect((await ask(architectChat, { question: "mutate", provider: "ollama" }))?.status).toBe(404);
  createCampaign(db, { name: "Other" });
  const other = createChat(db, 2);
  const otherPath = `/api/campaigns/1/chats/${other.id}/ask`;
  const response = await handleAskLoremaster(new Request(`http://localhost${otherPath}`, { method: "POST", body: JSON.stringify({ question: "private", provider: "ollama" }), headers: { "Content-Type": "application/json" } }), 1, other.id);
  expect(response?.status).toBe(404);
});

test("invalid questions fail before providers and route IDs remain campaign-bound", async () => {
  const chat = createChat(db, 1);
  expect((await ask(chat.id, { question: "" }))?.status).toBe(400);
  expect((await ask(chat.id, { question: "x", provider: "unknown" }))?.status).toBe(400);
  expect((await ask(chat.id, { question: "x", temperature: 3 }))?.status).toBe(400);
});
