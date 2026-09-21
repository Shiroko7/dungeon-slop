import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCampaign } from "../campaign/campaigns.ts";
import { openNotesDb } from "../notes/db.ts";
import { ingestDocument } from "../notes/ingest.ts";
import type { EmbeddingProvider } from "../notes/types.ts";
import { retrieveGrounding } from "./grounding.ts";
import { buildArchitectMessages } from "./prompts/architect.ts";
import { buildBlueprintMessages } from "./prompts/blueprint.ts";
import { buildNarratorMessages } from "./prompts/narrator.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

let db: Database;
const embedder: EmbeddingProvider = {
  model: "grounding-test",
  embed: async (texts) => texts.map(() => Float32Array.from([1, 2, 3])),
};

beforeEach(async () => {
  db = openNotesDb(":memory:");
  createCampaign(db, { name: "Vess" });
  createCampaign(db, { name: "Other" });
  await ingestDocument(db, embedder, {
    name: "test",
    model: "test",
    summarize: async () => ({ summary: "", entities: [] }),
  }, { campaignId: 1, filename: "crypt.md", content: "# Flooded Gate\n\nThe salt gate is below Vess." });
});

afterEach(() => db.close());

test("grounding is campaign-bound, bounded, and prompt-visible", async () => {
  const grounded = await retrieveGrounding(
    db,
    1,
    { documentIds: [1], query: "salt gate" },
    "unused fallback",
    () => embedder,
    new AbortController().signal,
  );
  expect(grounded.provenance.documentIds).toEqual([1]);
  expect(grounded.provenance.citations[0]).toMatchObject({ filename: "crypt.md", revision: 1 });
  expect(grounded.promptText).toContain("The salt gate is below Vess.");
  expect(buildArchitectMessages("build the crypt", [], grounded.promptText).at(-1)?.content).toContain("CAMPAIGN NOTE EVIDENCE");
  expect(buildBlueprintMessages({ prompt: "build the crypt", campaignEvidence: grounded.promptText }).at(-1)?.content).toContain("campaignEvidence");
  expect(buildNarratorMessages([], [], [], DEFAULT_CONFIG, { campaignEvidence: grounded.promptText }).at(-1)?.content).toContain("campaignEvidence");
});

test("invalid or cross-campaign source selections fail closed", async () => {
  await expect(retrieveGrounding(db, 1, { documentIds: [999], query: "gate" }, "", () => embedder, new AbortController().signal)).rejects.toThrow("not available");
  await expect(retrieveGrounding(db, 1, { documentIds: [0], query: "gate" }, "", () => embedder, new AbortController().signal)).rejects.toThrow("Invalid note source selection");
});

test("empty grounding is explicit instead of silently inventing source facts", async () => {
  const grounded = await retrieveGrounding(db, 1, { documentIds: [], query: "gate" }, "", () => embedder, new AbortController().signal);
  expect(grounded.provenance.status).toBe("no-sources");
  expect(grounded.provenance.citations).toHaveLength(0);
  expect(grounded.promptText).toContain("No campaign note passages");
});
