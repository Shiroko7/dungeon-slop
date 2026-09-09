import { describe, test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  assertEmbeddingModel,
  countChunks,
  decodeVector,
  deleteDocument,
  documentsMissingSummary,
  encodeVector,
  findDocumentByHash,
  getDocument,
  getMeta,
  listDocuments,
  openNotesDb,
  replaceDocument,
  setDocumentSummary,
  setMeta,
  storeEmbeddings,
} from "./db.ts";
import { createCampaign, deleteCampaign, listCampaigns } from "../campaign/campaigns.ts";
import { chunkDocument } from "./chunker.ts";
import type { Chunk } from "./types.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Every test starts with one campaign; nothing can be indexed without one. */
const CAMPAIGN = 1;

function fresh(): Database {
  const db = openNotesDb(":memory:");
  createCampaign(db, { name: "Ashen Vale" });
  return db;
}

function chunksOf(source: string): Chunk[] {
  return chunkDocument(source);
}

function seed(db: Database, filename: string, source: string, campaignId = CAMPAIGN) {
  return replaceDocument(db, {
    campaignId,
    filename,
    contentHash: `hash-of-${filename}`,
    tokens: 100,
    chunks: chunksOf(source),
  });
}

const NOTES_A = "# Session 12\n\nVashti led them through the tannery grate.\n";
const NOTES_B = "# Session 13\n\nThe Ashen Compact demanded tribute at the temple.\n";

function ftsSearch(db: Database, query: string): number[] {
  const rows = db
    .query("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank")
    .all(query) as Array<{ rowid: number }>;
  return rows.map((r) => r.rowid);
}

// ─── schema and lifecycle ─────────────────────────────────────────────────────

describe("documents", () => {
  test("insert returns ids that match what was stored", () => {
    const db = fresh();
    const { docId, chunkIds } = seed(db, "s12.md", NOTES_A);

    expect(docId).toBeGreaterThan(0);
    expect(chunkIds).toHaveLength(chunksOf(NOTES_A).length);
    expect(countChunks(db)).toBe(chunkIds.length);

    const doc = getDocument(db, docId);
    expect(doc?.filename).toBe("s12.md");
    expect(doc?.chunkCount).toBe(chunkIds.length);
  });

  test("re-uploading the same filename leaves no stale chunks behind", () => {
    const db = fresh();
    seed(db, "s12.md", `${NOTES_A}\n\n${NOTES_B}\n\n${NOTES_A}`);
    const before = countChunks(db);

    seed(db, "s12.md", "# Session 12\n\nRewritten, much shorter.\n");

    expect(listDocuments(db, CAMPAIGN)).toHaveLength(1);
    expect(countChunks(db)).toBeLessThan(before);
    expect(
      db.query("SELECT COUNT(*) AS n FROM chunks WHERE text LIKE '%tannery%'").get(),
    ).toEqual({ n: 0 });
  });

  test("delete cascades to chunks and embeddings", () => {
    const db = fresh();
    const { docId, chunkIds } = seed(db, "s12.md", NOTES_A);
    storeEmbeddings(db, [{ chunkId: chunkIds[0]!, vec: Float32Array.from([1, 0, 0]) }]);

    deleteDocument(db, docId);

    expect(countChunks(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM embeddings").get()).toEqual({ n: 0 });
    expect(getDocument(db, docId)).toBeNull();
  });

  test("finds a document by content hash", () => {
    const db = fresh();
    const { docId } = seed(db, "s12.md", NOTES_A);
    expect(findDocumentByHash(db, CAMPAIGN, "hash-of-s12.md")).toBe(docId);
    expect(findDocumentByHash(db, CAMPAIGN, "nope")).toBeNull();
  });

  test("summary and entities round-trip", () => {
    const db = fresh();
    const { docId } = seed(db, "s12.md", NOTES_A);

    setDocumentSummary(db, docId, "The party enters the sewers.", ["Vashti", "Kael"]);

    const doc = getDocument(db, docId);
    expect(doc?.summary).toBe("The party enters the sewers.");
    expect(doc?.entities).toEqual(["Vashti", "Kael"]);
  });

  test("a malformed entity list degrades instead of throwing", () => {
    const db = fresh();
    const { docId } = seed(db, "s12.md", NOTES_A);
    db.run("UPDATE documents SET entities = ? WHERE id = ?", ["{not json", docId]);

    expect(getDocument(db, docId)?.entities).toEqual([]);
  });

  test("lists only documents still missing a summary", () => {
    const db = fresh();
    const a = seed(db, "a.md", NOTES_A);
    seed(db, "b.md", NOTES_B);

    setDocumentSummary(db, a.docId, "done", []);

    expect(documentsMissingSummary(db, CAMPAIGN).map((d) => d.filename)).toEqual(["b.md"]);
  });
});

// ─── full-text index ──────────────────────────────────────────────────────────

describe("chunks_fts triggers", () => {
  test("insert populates the index", () => {
    const db = fresh();
    seed(db, "s12.md", NOTES_A);
    expect(ftsSearch(db, "tannery").length).toBeGreaterThan(0);
  });

  test("the index matches on the heading column too", () => {
    const db = fresh();
    seed(db, "s12.md", NOTES_A);
    expect(ftsSearch(db, "Session").length).toBeGreaterThan(0);
  });

  test("delete removes rows from the index", () => {
    const db = fresh();
    const { docId } = seed(db, "s12.md", NOTES_A);
    expect(ftsSearch(db, "tannery").length).toBeGreaterThan(0);

    deleteDocument(db, docId);

    expect(ftsSearch(db, "tannery")).toEqual([]);
  });

  test("re-upload does not leave the old text searchable", () => {
    const db = fresh();
    seed(db, "s12.md", NOTES_A);
    seed(db, "s12.md", NOTES_B);

    expect(ftsSearch(db, "tannery")).toEqual([]);
    expect(ftsSearch(db, "tribute").length).toBeGreaterThan(0);
  });

  test("index rowids resolve back to real chunks", () => {
    const db = fresh();
    seed(db, "s12.md", NOTES_A);

    for (const rowid of ftsSearch(db, "tannery")) {
      const row = db.query("SELECT text FROM chunks WHERE id = ?").get(rowid);
      expect(row).not.toBeNull();
    }
  });
});

// ─── vectors ──────────────────────────────────────────────────────────────────

describe("vector storage", () => {
  test("encode/decode is lossless", () => {
    const original = Float32Array.from([0.5, -0.25, 0, 1, -1]);
    const decoded = decodeVector(encodeVector(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  test("survives a round-trip through SQLite", () => {
    const db = fresh();
    const { chunkIds } = seed(db, "s12.md", NOTES_A);
    const vec = Float32Array.from([0.1, 0.2, 0.3, 0.4]);

    storeEmbeddings(db, [{ chunkId: chunkIds[0]!, vec }]);

    const row = db.query("SELECT vec FROM embeddings WHERE chunk_id = ?").get(chunkIds[0]!) as {
      vec: Uint8Array;
    };
    const back = decodeVector(row.vec);
    expect(back).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(back[i]!).toBeCloseTo(vec[i]!, 6);
    }
  });

  test("storing twice for one chunk updates rather than duplicating", () => {
    const db = fresh();
    const { chunkIds } = seed(db, "s12.md", NOTES_A);
    const id = chunkIds[0]!;

    storeEmbeddings(db, [{ chunkId: id, vec: Float32Array.from([1, 0]) }]);
    storeEmbeddings(db, [{ chunkId: id, vec: Float32Array.from([0, 1]) }]);

    expect(db.query("SELECT COUNT(*) AS n FROM embeddings").get()).toEqual({ n: 1 });
    const row = db.query("SELECT vec FROM embeddings WHERE chunk_id = ?").get(id) as {
      vec: Uint8Array;
    };
    expect(Array.from(decodeVector(row.vec))).toEqual([0, 1]);
  });
});

// ─── meta ─────────────────────────────────────────────────────────────────────

describe("meta and model pinning", () => {
  test("set then get", () => {
    const db = fresh();
    setMeta(db, "k", "v");
    expect(getMeta(db, "k")).toBe("v");
    setMeta(db, "k", "v2");
    expect(getMeta(db, "k")).toBe("v2");
    expect(getMeta(db, "absent")).toBeNull();
  });

  test("the first embedding model wins and is recorded", () => {
    const db = fresh();
    assertEmbeddingModel(db, "voyage-4-lite", 1024);
    expect(getMeta(db, "embedding_model")).toBe("voyage-4-lite:1024");
  });

  test("the same model and dimension is accepted repeatedly", () => {
    const db = fresh();
    assertEmbeddingModel(db, "voyage-4-lite", 1024);
    expect(() => assertEmbeddingModel(db, "voyage-4-lite", 1024)).not.toThrow();
  });

  test("a different model is refused", () => {
    const db = fresh();
    assertEmbeddingModel(db, "voyage-4-lite", 1024);
    expect(() => assertEmbeddingModel(db, "gemini-embedding-001", 1024)).toThrow(/mismatch/i);
  });

  test("the same model at a different dimension is refused", () => {
    const db = fresh();
    assertEmbeddingModel(db, "voyage-4-lite", 1024);
    expect(() => assertEmbeddingModel(db, "voyage-4-lite", 512)).toThrow(/mismatch/i);
  });
});

// ─── campaign scoping ─────────────────────────────────────────────────────────

describe("campaign isolation", () => {
  test("the same filename can exist in two campaigns", () => {
    const db = fresh();
    const second = createCampaign(db, { name: "Kestrel Reach" });

    const a = seed(db, "session-01.md", NOTES_A, CAMPAIGN);
    const b = seed(db, "session-01.md", NOTES_B, second.id);

    expect(a.docId).not.toBe(b.docId);
    expect(listDocuments(db, CAMPAIGN)).toHaveLength(1);
    expect(listDocuments(db, second.id)).toHaveLength(1);
  });

  test("listing one campaign never returns another's documents", () => {
    const db = fresh();
    const second = createCampaign(db, { name: "Kestrel Reach" });
    seed(db, "a.md", NOTES_A, CAMPAIGN);
    seed(db, "b.md", NOTES_B, second.id);

    expect(listDocuments(db, CAMPAIGN).map((d) => d.filename)).toEqual(["a.md"]);
    expect(listDocuments(db, second.id).map((d) => d.filename)).toEqual(["b.md"]);
  });

  test("a hash lookup is scoped, so a shared file is not mistaken for a duplicate", () => {
    const db = fresh();
    const second = createCampaign(db, { name: "Kestrel Reach" });
    const a = seed(db, "bestiary.md", NOTES_A, CAMPAIGN);

    expect(findDocumentByHash(db, second.id, "hash-of-bestiary.md")).toBeNull();
    expect(findDocumentByHash(db, CAMPAIGN, "hash-of-bestiary.md")).toBe(a.docId);
  });

  test("re-upload only replaces within its own campaign", () => {
    const db = fresh();
    const second = createCampaign(db, { name: "Kestrel Reach" });
    seed(db, "notes.md", NOTES_A, CAMPAIGN);
    const kept = seed(db, "notes.md", NOTES_B, second.id);

    seed(db, "notes.md", "# Rewritten\n\nNothing of the old text.\n", CAMPAIGN);

    expect(getDocument(db, kept.docId)).not.toBeNull();
    expect(ftsSearch(db, "tribute").length).toBeGreaterThan(0);
    expect(ftsSearch(db, "tannery")).toEqual([]);
  });

  test("deleting a campaign takes its documents, chunks and embeddings with it", () => {
    const db = fresh();
    const second = createCampaign(db, { name: "Kestrel Reach" });
    const doomed = seed(db, "a.md", NOTES_A, CAMPAIGN);
    const kept = seed(db, "b.md", NOTES_B, second.id);
    storeEmbeddings(db, [{ chunkId: doomed.chunkIds[0]!, vec: Float32Array.from([1, 0]) }]);
    storeEmbeddings(db, [{ chunkId: kept.chunkIds[0]!, vec: Float32Array.from([0, 1]) }]);

    expect(deleteCampaign(db, CAMPAIGN)).toBe(true);

    expect(getDocument(db, doomed.docId)).toBeNull();
    expect(countChunks(db, second.id)).toBe(kept.chunkIds.length);
    expect(countChunks(db)).toBe(kept.chunkIds.length);
    expect(db.query("SELECT COUNT(*) AS n FROM embeddings").get()).toEqual({ n: 1 });
    expect(ftsSearch(db, "tannery")).toEqual([]);
    expect(listCampaigns(db).map((c) => c.id)).toEqual([second.id]);
  });

  test("chunk counts can be read per campaign or across all of them", () => {
    const db = fresh();
    const second = createCampaign(db, { name: "Kestrel Reach" });
    const a = seed(db, "a.md", NOTES_A, CAMPAIGN);
    const b = seed(db, "b.md", NOTES_B, second.id);

    expect(countChunks(db, CAMPAIGN)).toBe(a.chunkIds.length);
    expect(countChunks(db, second.id)).toBe(b.chunkIds.length);
    expect(countChunks(db)).toBe(a.chunkIds.length + b.chunkIds.length);
  });

  test("a missing-summary backfill can be narrowed to one campaign", () => {
    const db = fresh();
    const second = createCampaign(db, { name: "Kestrel Reach" });
    seed(db, "a.md", NOTES_A, CAMPAIGN);
    seed(db, "b.md", NOTES_B, second.id);

    expect(documentsMissingSummary(db, CAMPAIGN).map((d) => d.filename)).toEqual(["a.md"]);
    expect(documentsMissingSummary(db).map((d) => d.filename)).toEqual(["a.md", "b.md"]);
  });

  test("documents carry the campaign that owns them", () => {
    const db = fresh();
    const { docId } = seed(db, "a.md", NOTES_A);
    expect(getDocument(db, docId)?.campaignId).toBe(CAMPAIGN);
  });
});
