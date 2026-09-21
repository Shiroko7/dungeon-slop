import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as context from "../db/context.ts";
import * as registry from "../ai/provider-registry.ts";
import * as notesContext from "../notes/context.ts";
import { createCampaign } from "../campaign/campaigns.ts";
import { openNotesDb } from "../notes/db.ts";
import { ingestDocument } from "../notes/ingest.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";
import { geometry } from "../test-fixtures.ts";
import type { AIProvider } from "../ai/types.ts";
import type { EmbeddingProvider } from "../notes/types.ts";
import { handleGenerateBlueprint } from "./generate-blueprint.ts";
import { handleDescribeRooms } from "./describe-rooms.ts";

let db: Database;
const embedder: EmbeddingProvider = {
  model: "grounded-api",
  embed: async (texts) => texts.map(() => Float32Array.from([1, 2, 3])),
};

function fixtureProvider(): AIProvider {
  return {
    name: "ollama",
    defaultModel: "fixture",
    models: [],
    complete: async () => ({ content: "{}", usage: { inputTokens: 1, outputTokens: 1 }, model: "fixture" }),
    async *streamComplete(_apiKey, options) {
      const content = options.messages.at(-1)?.content.includes('"rooms"')
        ? JSON.stringify([{ roomId: 0, description: { name: "Salt Gate", features: "The gate sits below Vess." } }])
        : JSON.stringify({ name: "Grounded Crypt", nodes: [
            { key: "entrance", name: "Salt Gate", role: "entrance", tier: 0 },
            { key: "boss", name: "Vess Sanctum", role: "boss", tier: 1 },
          ], edges: [{ from: "entrance", to: "boss", gating: "the salt key", door: "Locked" }] });
      yield content;
      return { content, usage: { inputTokens: 1, outputTokens: 1 }, model: "fixture" };
    },
  };
}

beforeEach(async () => {
  db = openNotesDb(":memory:");
  createCampaign(db, { name: "Grounded" });
  await ingestDocument(db, embedder, {
    name: "test",
    model: "test",
    summarize: async () => ({ summary: "", entities: [] }),
  }, { campaignId: 1, filename: "crypt.md", content: "# Salt Gate\n\nThe gate sits below Vess." });
  spyOn(context, "appDb").mockImplementation(() => db);
  spyOn(notesContext, "notesEmbedder").mockImplementation(() => embedder);
  spyOn(registry, "getProvider").mockImplementation(() => fixtureProvider());
  spyOn(registry, "getApiKey").mockReturnValue("");
});

afterEach(() => { mock.restore(); db.close(); });

async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

test("blueprint generation retrieves selected notes and persists provenance", async () => {
  const response = await handleGenerateBlueprint(new Request("http://localhost/api/generate-blueprint", {
    method: "POST",
    body: JSON.stringify({ prompt: "Build the crypt", provider: "ollama", model: "fixture", campaignId: 1, grounding: { documentIds: [1], query: "salt gate" } }),
  }));
  const output = await events(response);
  const complete = output.find((event) => event.blueprint) as { blueprint?: { grounding?: { citations: Array<{ filename: string }> } } } | undefined;
  expect(output.some((event) => Array.isArray(event.citations))).toBe(true);
  expect(complete?.blueprint?.grounding?.citations[0]?.filename).toBe("crypt.md");
});

test("narrator output carries the same source provenance to the saved room content", async () => {
  const room = geometry().rooms[0]!;
  const response = await handleDescribeRooms(new Request("http://localhost/api/describe-rooms", {
    method: "POST",
    body: JSON.stringify({ rooms: [room], allRooms: [room], corridors: [], config: DEFAULT_CONFIG, provider: "ollama", model: "fixture", campaignId: 1, sourcePrompt: "salt gate", grounding: { documentIds: [1], query: "salt gate" } }),
  }));
  const output = await events(response);
  const complete = output.find((event) => Array.isArray(event.descriptions)) as { descriptions?: Array<{ description: { grounding?: { citations: Array<{ filename: string }> } } }> } | undefined;
  expect(complete?.descriptions?.[0]?.description.grounding?.citations[0]?.filename).toBe("crypt.md");
});
