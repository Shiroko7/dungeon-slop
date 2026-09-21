import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as context from "../db/context.ts";
import * as providers from "../notes/context.ts";
import { createCampaign } from "../campaign/campaigns.ts";
import { openNotesDb } from "../notes/db.ts";
import { ingestDocument } from "../notes/ingest.ts";
import { handleApiRoute } from "./routes.ts";
import type { EmbeddingProvider } from "../notes/types.ts";

let db: Database;
let embedCalls: number;
const embedder: EmbeddingProvider = { model: "test-api", embed: async (texts) => { embedCalls++; return texts.map(() => Float32Array.from([1, 2])); } };
beforeEach(async () => {
  db = openNotesDb(":memory:");
  createCampaign(db, { name: "First" }); createCampaign(db, { name: "Second" });
  spyOn(context, "appDb").mockImplementation(() => db);
  spyOn(providers, "notesEmbedder").mockImplementation(() => embedder);
  for (const campaignId of [1, 2]) await ingestDocument(db, embedder,
    { name: "test", model: "test", summarize: async () => ({ summary: "Fixture", entities: [] }) },
    { campaignId, filename: "shared.md", content: `# Mira\n\nCampaign ${campaignId} bronze key.` });
  embedCalls = 0;
});
afterEach(() => { mock.restore(); db.close(); });
async function route(path: string, body?: unknown) {
  return (await handleApiRoute(new Request(`http://localhost${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), path.split("?")[0]!))!;
}

test("diagnostic API returns campaign-bound citations whose reader deep links resolve", async () => {
  const response = await route("/api/campaigns/1/notes/search", { query: "Mira" });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.results).toHaveLength(1);
  const cite = result.results[0].citation;
  const reader = await route(`/api/campaigns/1/notes/${cite.documentId}/revisions/${cite.revision}?chunk=${cite.chunkId}`);
  expect(reader.status).toBe(200);
  expect((await reader.json()).source).toContain("Campaign 1");
  expect(embedCalls).toBe(0);
});

test("misowned source IDs and reader routes fail without resolving providers", async () => {
  expect((await route("/api/campaigns/1/notes/search", { query: "Mira", mode: "semantic", documentIds: [2] })).status).toBe(404);
  expect((await route("/api/campaigns/1/notes/2/revisions/1")).status).toBe(404);
  expect((await route("/api/campaigns/1/notes/1/revisions/1?chunk=2")).status).toBe(410);
  expect(embedCalls).toBe(0);
});

test("replaced citations return 410 rather than the new source", async () => {
  await ingestDocument(db, embedder, { name: "test", model: "test", summarize: async () => ({ summary: "New", entities: [] }) },
    { campaignId: 1, filename: "shared.md", content: "New content" });
  const response = await route("/api/campaigns/1/notes/1/revisions/1");
  expect(response.status).toBe(410);
  expect((await response.json()).code).toBe("revision_removed");
  expect((await route("/api/campaigns/1/notes/1/revisions/2")).status).toBe(200);
});

test("invalid searches and reader parameters are rejected with useful client errors", async () => {
  expect((await route("/api/campaigns/1/notes/search", { query: "Mira", limit: 200 })).status).toBe(400);
  expect((await route("/api/campaigns/1/notes/search", {})).status).toBe(400);
  expect((await route("/api/campaigns/1/notes/1/revisions/1?chunk=oops")).status).toBe(400);
  expect((await route("/api/campaigns/999/notes/search", { query: "Mira" })).status).toBe(404);
});

test("hybrid provider failure is a visible keyword fallback over HTTP", async () => {
  spyOn(providers, "notesEmbedder").mockImplementation(() => { throw new Error("Missing query credentials"); });
  const response = await route("/api/campaigns/1/notes/search", { query: "Mira", mode: "hybrid" });
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.usedMode).toBe("lexical");
  expect(result.warnings.join(" ")).toContain("Missing query credentials");
  expect(result.results).toHaveLength(1);
});
