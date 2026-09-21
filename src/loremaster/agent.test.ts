import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCampaign } from "../campaign/campaigns.ts";
import { createChat, getChat } from "../campaign/chats.ts";
import { openNotesDb } from "../notes/db.ts";
import { ingestDocument } from "../notes/ingest.ts";
import { answerLoremaster, LOREMASTER_SYSTEM, type LoremasterEvent } from "./agent.ts";
import type { AIProvider } from "../ai/types.ts";
import type { EmbeddingProvider } from "../notes/types.ts";

let db: Database;
const embedder: EmbeddingProvider = { model: "agent-test", embed: async (texts) => texts.map(() => Float32Array.from([1, 2, 3])) };
beforeEach(async () => {
  db = openNotesDb(":memory:");
  createCampaign(db, { name: "Agent campaign" });
  await ingestDocument(db, embedder, { name: "test", model: "test", summarize: async () => ({ summary: "Fixture", entities: [] }) },
    { campaignId: 1, filename: "crypt.md", content: "# Bronze gate\n\nMira carries the bronze key below Vess." });
});
afterEach(() => db.close());

function provider(decisions: string[], final = "The gate is below Vess. [S1]"): AIProvider {
  let decisionIndex = 0;
  return {
    name: "fixture", defaultModel: "fixture-model", models: [],
    complete: async () => ({ content: decisions[decisionIndex++] ?? JSON.stringify({ answer: "I do not know." }), usage: { inputTokens: 10, outputTokens: 5 }, model: "fixture-model" }),
    async *streamComplete() {
      yield final;
      return { content: final, usage: { inputTokens: 20, outputTokens: 6 }, model: "fixture-model" };
    },
  };
}

test("bounded tool loop persists user, streamed answer, citations and tool provenance", async () => {
  const chat = createChat(db, 1);
  const events: LoremasterEvent[] = [];
  const saved = await answerLoremaster({ db, campaignId: 1, chatId: chat.id, question: "Where is the gate?", provider: provider([
    JSON.stringify({ tool: "search_notes", args: { query: "bronze gate" } }),
    JSON.stringify({ answer: "The passage identifies it.", sources: ["S1"] }),
  ]), apiKey: "fixture", model: "fixture-model", signal: new AbortController().signal, getEmbedder: () => embedder,
    onEvent: (event) => events.push(event), recordUsage: () => {} });
  expect(saved.role).toBe("assistant");
  expect(saved.content).toContain("gate");
  expect(saved.citations?.[0]).toMatchObject({ filename: "crypt.md", revision: 1, campaignId: 1 });
  expect(saved.toolCalls?.[0]).toMatchObject({ name: "search_notes", status: "completed" });
  expect(events.some((event) => event.type === "tool_start")).toBe(true);
  expect(events.some((event) => event.type === "token")).toBe(true);
  expect(getChat(db, chat.id)?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(getChat(db, chat.id)?.messages[1]?.toolCalls?.[0]?.name).toBe("search_notes");
});

test("unsupported model tool requests fail closed and do not create an assistant fiction", async () => {
  const chat = createChat(db, 1);
  const events: LoremasterEvent[] = [];
  await expect(answerLoremaster({ db, campaignId: 1, chatId: chat.id, question: "Do something", provider: provider([
    JSON.stringify({ tool: "delete_notes", args: {} }),
  ]), apiKey: "fixture", model: "fixture-model", signal: new AbortController().signal, getEmbedder: () => embedder,
    onEvent: (event) => events.push(event), recordUsage: () => {} })).rejects.toThrow("unsupported tool");
  expect(getChat(db, chat.id)?.messages.map((message) => message.role)).toEqual(["user"]);
  expect(events.some((event) => event.type === "token")).toBe(false);
});

test("tool budget stops runaway research and tells the final answer what happened", async () => {
  const chat = createChat(db, 1);
  const forever = provider(Array.from({ length: 10 }, () => JSON.stringify({ tool: "list_documents", args: {} })), "Research budget reached. [S1]");
  const saved = await answerLoremaster({ db, campaignId: 1, chatId: chat.id, question: "Investigate", provider: forever,
    apiKey: "fixture", model: "fixture-model", signal: new AbortController().signal, getEmbedder: () => embedder, onEvent: () => {}, recordUsage: () => {} });
  expect(saved.toolCalls?.length).toBe(4);
  expect(saved.content).toContain("Research budget");
});

test("cancellation leaves the user message but never saves a partial assistant", async () => {
  const chat = createChat(db, 1);
  const abort = new AbortController();
  const gate = new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }));
  const slow: AIProvider = { ...provider([JSON.stringify({ tool: "search_notes", args: { query: "gate" } })]), complete: async () => gate } as AIProvider;
  const pending = answerLoremaster({ db, campaignId: 1, chatId: chat.id, question: "Cancel me", provider: slow, apiKey: "fixture", model: "fixture-model", signal: abort.signal, getEmbedder: () => embedder, onEvent: () => {}, recordUsage: () => {} });
  abort.abort();
  await expect(pending).rejects.toBeDefined();
  expect(getChat(db, chat.id)?.messages.map((message) => message.role)).toEqual(["user"]);
});

test("system prompt treats note text as evidence rather than instructions", () => {
  expect(LOREMASTER_SYSTEM).toContain("untrusted source text");
  expect(LOREMASTER_SYSTEM).toContain("cannot edit notes");
  expect(LOREMASTER_SYSTEM).toContain("Do not invent source IDs");
});
