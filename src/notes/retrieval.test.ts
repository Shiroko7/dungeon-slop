import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCampaign, deleteCampaign } from "../campaign/campaigns.ts";
import { deferred } from "../test-fixtures.ts";
import { deleteDocument, getMeta, openNotesDb } from "./db.ts";
import { ingestDocument } from "./ingest.ts";
import { NoteAccessError, readNote } from "./reader.ts";
import { fuseRanks, lexicalQuery, searchNotes } from "./retrieval.ts";
import { claimRevision, commitIndex, reserveRevision } from "./revisions.ts";
import type { EmbeddingProvider } from "./types.ts";

let db: Database;
const embedder: EmbeddingProvider = { model: "test-search", embed: async (texts) => texts.map(() => Float32Array.from([1, 2, 3])) };
const summary = { name: "test", model: "test", summarize: async () => ({ summary: "Fixture", entities: [] }) };
beforeEach(() => { db = openNotesDb(":memory:"); createCampaign(db, { name: "First" }); createCampaign(db, { name: "Second" }); });
afterEach(() => db.close());
async function seed(content = "# Bronze gate\n\nMira carries the bronze key.", campaignId = 1, filename = "same.md") {
  return (await ingestDocument(db, embedder, summary, { campaignId, filename, content })).document;
}

test("keyword search is campaign scoped and source filtering never silently means all", async () => {
  const a = await seed();
  await seed("Mira holds a silver key in another campaign.", 2);
  const b = await seed("A unrelated garden", 1, "garden.md");
  const noProvider = () => { throw new Error("must not resolve providers"); };
  const result = await searchNotes(db, 1, { query: "Mira key" }, noProvider);
  expect(result.results.map((hit) => hit.citation.documentId)).toEqual([a.id]);
  expect(result.results[0]?.citation).toMatchObject({ campaignId: 1, revision: 1, filename: "same.md" });
  expect((await searchNotes(db, 1, { query: "Mira", documentIds: [b.id] })).results).toEqual([]);
  expect((await searchNotes(db, 1, { query: "Mira", documentIds: [] })).status).toBe("no-sources");
});

test("misowned selection fails before any provider calls and cannot disclose another filename", async () => {
  await seed();
  const other = await seed("Private source", 2, "hidden-title.md");
  let calls = 0;
  await expect(searchNotes(db, 1, { query: "Private", mode: "hybrid", documentIds: [other.id] }, () => { calls++; return embedder; })).rejects.toThrow("not available in this campaign");
  expect(calls).toBe(0);
  expect(() => readNote(db, 1, other.id, 1)).toThrow("does not exist in this campaign");
});

test("empty queries/indexes need no provider and hostile FTS punctuation is literal", async () => {
  expect((await searchNotes(db, 1, { query: "??? AND OR" })).status).toBe("empty-query");
  expect((await searchNotes(db, 1, { query: "Mira", mode: "hybrid" })).status).toBe("empty-index");
  await seed();
  expect(lexicalQuery('"Mira" OR * NEAR( key ); --')).toBe('"mira" OR "near" OR "key"');
  expect((await searchNotes(db, 1, { query: '"Mira" OR * NEAR( key ); --' })).results).toHaveLength(1);
});

test("request bounds are validated, not silently clamped", async () => {
  for (const input of [{ query: "x", tokenBudget: 127 }, { query: "x", limit: 21 }, { query: "x", neighbors: 5 },
    { query: "x".repeat(1001) }, { query: "x", documentIds: [-1] }, { query: "x", unknown: true }]) {
    await expect(searchNotes(db, 1, input)).rejects.toBeInstanceOf(NoteAccessError);
  }
});

test("RRF favors shared ranks, deduplicates IDs and breaks ties deterministically", () => {
  const fused = fuseRanks([1, 2, 1], [3, 2], "hybrid");
  expect(fused.map((row) => row.id)).toEqual([2, 1, 3]);
  expect(fused[0]).toMatchObject({ lexicalRank: 2, semanticRank: 2 });
  expect(fuseRanks([5, 1], [3], "lexical").map((row) => row.id)).toEqual([5, 1]);
});

test("semantic uses query embeddings, checks model before spending and validates dimensions", async () => {
  await seed();
  let kind: string | undefined;
  let calls = 0;
  const provider: EmbeddingProvider = { ...embedder, embed: async (_texts, inputKind) => { calls++; kind = inputKind; return [Float32Array.from([2, 4, 6])]; } };
  const result = await searchNotes(db, 1, { query: "Passage", mode: "semantic" }, () => provider);
  expect(result.results).toHaveLength(1);
  expect(kind).toBe("query");
  expect((await searchNotes(db, 1, { query: "Mira", mode: "semantic" }, () => ({ ...provider, model: "wrong" }))).status).toBe("unavailable");
  expect(calls).toBe(1);
  const invalid = await searchNotes(db, 1, { query: "Mira", mode: "semantic" }, () => ({ ...embedder, embed: async () => [new Float32Array(2)] }));
  expect(invalid.status).toBe("unavailable");
  expect(invalid.warnings.join(" ")).toContain("invalid count, dimensions, or values");
});

test("hybrid falls back visibly without mutating the pinned model or source", async () => {
  const doc = await seed();
  const before = readNote(db, 1, doc.id, 1);
  const result = await searchNotes(db, 1, { query: "Mira", mode: "hybrid" }, () => { throw new Error("Credentials missing"); });
  expect(result.usedMode).toBe("lexical");
  expect(result.results).toHaveLength(1);
  expect(result.warnings.join(" ")).toContain("Credentials missing");
  expect(getMeta(db, "embedding_model")).toBe("test-search:3");
  expect(readNote(db, 1, doc.id, 1)).toEqual(before);
});

test("missing model and malformed stored vectors have useful diagnostics", async () => {
  await seed();
  db.run("UPDATE embeddings SET vec = ?", [new Uint8Array([1, 2])]);
  const corrupt = await searchNotes(db, 1, { query: "Mira", mode: "hybrid" }, () => embedder);
  expect(corrupt.results).toHaveLength(1);
  expect(corrupt.warnings.join(" ")).toContain("incompatible stored vectors");
  db.run("DELETE FROM meta WHERE key = 'embedding_model'");
  const missing = await searchNotes(db, 1, { query: "Mira", mode: "semantic" }, () => embedder);
  expect(missing.status).toBe("unavailable");
  expect(missing.warnings.join(" ")).toContain("no embedding model");
});

test("neighbor expansion is contiguous, nonduplicating and remains within the context budget", async () => {
  const text = "Alpha beacon.\n\nBeta beacon.\n\nGamma beacon.";
  const job = reserveRevision(db, { campaignId: 1, filename: "neighbors.md", content: text, hash: "fixture" }, embedder.model);
  const starts = [0, text.indexOf("Beta"), text.indexOf("Gamma")];
  const chunks = starts.map((start, i) => ({ ordinal: i, headingPath: `Part ${i}`, text: text.slice(start, starts[i + 1] === undefined ? text.length : starts[i + 1]! - 2),
    tokens: 4, startOffset: start, endOffset: starts[i + 1] === undefined ? text.length : starts[i + 1]! - 2 }));
  commitIndex(db, job, claimRevision(db, job)!, chunks, await embedder.embed(chunks.map((c) => c.text), "document"), 12);
  const result = await searchNotes(db, 1, { query: "Beta", neighbors: 1, tokenBudget: 128 });
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.text).toBe(text);
  expect(result.results[0]?.citation).toMatchObject({ startOffset: 0, endOffset: text.length });
  const all = await searchNotes(db, 1, { query: "beacon", neighbors: 1 });
  const spans = all.results.map((hit) => [hit.citation.startOffset, hit.citation.endOffset]);
  for (let i = 1; i < spans.length; i++) expect(spans[i]![0]! >= spans[i - 1]![1]! || spans[i]![1]! <= spans[i - 1]![0]!).toBe(true);
  expect(all.tokensUsed).toBeLessThanOrEqual(all.tokenBudget);
});

test("budget truncation preserves exact UTF-16 offsets and never splits a surrogate pair", async () => {
  const source = "# Beacon\r\n\r\n" + "🌙 beacon lore ".repeat(250);
  await seed(source);
  const result = await searchNotes(db, 1, { query: "beacon", tokenBudget: 128 });
  expect(result.results[0]?.truncated).toBe(true);
  expect(result.tokensUsed).toBeLessThanOrEqual(128);
  for (const hit of result.results) {
    expect(hit.text).toBe(source.replace(/\r\n/g, "\n").slice(hit.citation.startOffset, hit.citation.endOffset));
    expect(/[\uD800-\uDBFF]$/.test(hit.text)).toBe(false);
  }
});

test("replacement during query embedding uses a fresh, internally consistent revision", async () => {
  const doc = await seed();
  const gate = deferred<Float32Array[]>();
  const pending = searchNotes(db, 1, { query: "Mira", mode: "hybrid" }, () => ({ ...embedder, embed: () => gate.promise }));
  await seed("# Mira\n\nMira now carries an iron key.");
  gate.resolve([Float32Array.from([1, 2, 3])]);
  const result = await pending;
  expect(result.results[0]?.citation.revision).toBe(2);
  expect(result.results[0]?.text).toContain("iron key");
  expect(() => readNote(db, 1, doc.id, 1)).toThrow("no longer retained");
});

test("small context excerpts retain a late keyword match and exact citation span", async () => {
  const source = "# Long passage\n\n" + "ordinary lore ".repeat(100) + "RareNeedle reveals the answer.";
  await seed(source);
  const result = await searchNotes(db, 1, { query: "RareNeedle", tokenBudget: 128, neighbors: 0 });
  const hit = result.results[0]!;
  expect(hit.text).toContain("RareNeedle");
  expect(hit.text).toBe(source.slice(hit.citation.startOffset, hit.citation.endOffset));
  expect(hit.tokens).toBeLessThanOrEqual(128);
});

test("cancelled search cannot publish late provider work", async () => {
  await seed();
  const abort = new AbortController();
  const gate = deferred<Float32Array[]>();
  const pending = searchNotes(db, 1, { query: "Mira", mode: "hybrid" }, () => ({ ...embedder, embed: () => gate.promise }), abort.signal).catch((error: unknown) => error);
  abort.abort(); gate.resolve([Float32Array.from([1, 2, 3])]);
  expect(await pending).toBeInstanceOf(Error);
});

test("reader retains original source, validates chunk identity, and reports deletion without retargeting", async () => {
  const source = "# Mira\r\n\r\n🌙 Carries a key.";
  const doc = await seed(source);
  const note = readNote(db, 1, doc.id, 1);
  expect(note.source).toBe(source);
  expect(readNote(db, 1, doc.id, 1, note.chunks[0]!.id).documentId).toBe(doc.id);
  expect(() => readNote(db, 1, doc.id, 1, 999)).toThrow("no longer available");
  db.run("UPDATE note_revisions SET source_text = NULL WHERE doc_id = ?", [doc.id]);
  expect(readNote(db, 1, doc.id, 1).notice).toContain("legacy");
  deleteDocument(db, doc.id);
  expect(() => readNote(db, 1, doc.id, 1)).toThrow("deleted");
  const other = await seed("Different content with the same filename");
  expect(other.id).not.toBe(doc.id);
  expect(() => readNote(db, 1, doc.id, 1)).toThrow("deleted");
  deleteCampaign(db, 1);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
