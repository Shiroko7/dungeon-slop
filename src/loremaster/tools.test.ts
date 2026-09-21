import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCampaign } from "../campaign/campaigns.ts";
import { createChat } from "../campaign/chats.ts";
import { openNotesDb } from "../notes/db.ts";
import { ingestDocument } from "../notes/ingest.ts";
import { executeTool } from "./tools.ts";
import type { EmbeddingProvider } from "../notes/types.ts";

let db: Database;
const embedder: EmbeddingProvider = { model: "tool-test", embed: async (texts) => texts.map(() => Float32Array.from([1, 2, 3])) };
beforeEach(async () => { db = openNotesDb(":memory:"); createCampaign(db, { name: "Tools" }); await ingestDocument(db, embedder, { name: "test", model: "test", summarize: async () => ({ summary: "", entities: [] }) }, { campaignId: 1, filename: "one.md", content: "# One\n\nA private fact." }); });
afterEach(() => db.close());

test("list, search and read tools stay campaign bound and return inspectable evidence", async () => {
  const list = await executeTool(db, 1, "list_documents", {}, () => embedder, new AbortController().signal);
  expect(list.text).toContain("one.md");
  const search = await executeTool(db, 1, "search_notes", { query: "private fact", mode: "lexical" }, () => embedder, new AbortController().signal);
  expect(search.passages).toHaveLength(1);
  expect(search.text).toContain("[S1]");
  const read = await executeTool(db, 1, "read_document", { documentId: 1, revision: 1, chunkId: search.passages[0]!.citation.chunkId }, () => embedder, new AbortController().signal);
  expect(read.text).toContain("private fact");
  expect(read.record.status).toBe("completed");
});

test("unknown, misowned and malformed tools fail before disclosing data", async () => {
  await expect(executeTool(db, 1, "drop_database", {}, () => embedder, new AbortController().signal)).rejects.toThrow("Unknown Loremaster tool");
  await expect(executeTool(db, 1, "search_notes", { query: "x", documentIds: [999] }, () => embedder, new AbortController().signal)).rejects.toThrow("not available");
  await expect(executeTool(db, 1, "read_document", { documentId: 1, revision: 99 }, () => embedder, new AbortController().signal)).rejects.toThrow("does not exist");
});

test("tools reject cancellation and never mutate chats", async () => {
  const chat = createChat(db, 1);
  const abort = new AbortController(); abort.abort();
  await expect(executeTool(db, 1, "list_documents", {}, () => embedder, abort.signal)).rejects.toBeDefined();
  expect(db.query("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(chat.id)).toEqual({ n: 0 });
});
