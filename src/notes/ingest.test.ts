import { describe, test, expect } from "bun:test";
import { countChunks, decodeVector, getDocument, listDocuments, openNotesDb } from "./db.ts";
import { embeddingText, hashContent, ingestDocument, isSupportedFile } from "./ingest.ts";
import { dot, normalize } from "./embeddings.ts";
import { createCampaign } from "../campaign/campaigns.ts";

/** Nothing can be indexed without an owning campaign, so every test opens with one. */
const CAMPAIGN = 1;

function fresh() {
  const db = openNotesDb(":memory:");
  createCampaign(db, { name: "Ashen Vale" });
  return db;
}
import type { EmbeddingProvider, SummarizerProvider } from "./types.ts";

// ─── stubs ────────────────────────────────────────────────────────────────────

/**
 * Deterministic bag-of-characters embedder. Not semantically meaningful, but it
 * is stable, has real dimensionality, and gives similar texts similar vectors —
 * enough to exercise the storage and normalisation path without a network call.
 */
function fakeEmbedder(dimensions = 64, model = "fake-embed"): EmbeddingProvider {
  return {
    model,
    async embed(texts) {
      return texts.map((text) => {
        const vec = new Float32Array(dimensions);
        for (let i = 0; i < text.length; i++) {
          vec[text.charCodeAt(i) % dimensions]! += 1;
        }
        return vec;
      });
    },
  };
}

/** Throws if called: every test here defers summarization. */
const noSummarizer: SummarizerProvider = {
  name: "unused",
  model: "unused",
  summarize() {
    throw new Error("summarizer must not be called when deferSummary is set");
  },
};

const SESSION = `# Session 12

The party regrouped at the Gilded Hart before dawn.

## The Sewers

Vashti led them through the grate behind the tannery.

## Aftermath

They surfaced near the temple district, short one guide.
`;

// ─── file acceptance ──────────────────────────────────────────────────────────

describe("isSupportedFile", () => {
  test("accepts the documented extensions, case-insensitively", () => {
    for (const name of ["a.md", "b.MD", "c.txt", "d.Markdown", "e.text"]) {
      expect(isSupportedFile(name)).toBe(true);
    }
  });

  test("rejects everything else", () => {
    for (const name of ["a.pdf", "b.docx", "c", "d.md.zip", "notes.json"]) {
      expect(isSupportedFile(name)).toBe(false);
    }
  });
});

describe("hashContent", () => {
  test("is stable and content-sensitive", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});

describe("embeddingText", () => {
  test("prepends the heading breadcrumb when there is one", () => {
    const text = embeddingText({
      ordinal: 0,
      headingPath: "Session 12 › The Sewers",
      text: "three goblins waited",
      tokens: 5,
      startOffset: 0,
      endOffset: 20,
    });
    expect(text).toBe("Session 12 › The Sewers\n\nthree goblins waited");
  });

  test("leaves headingless chunks untouched", () => {
    const text = embeddingText({
      ordinal: 0,
      headingPath: "",
      text: "plain note",
      tokens: 3,
      startOffset: 0,
      endOffset: 10,
    });
    expect(text).toBe("plain note");
  });
});

// ─── the pipeline ─────────────────────────────────────────────────────────────

describe("ingestDocument", () => {
  test("indexes a document end to end", async () => {
    const db = fresh();
    const result = await ingestDocument(
      db,
      fakeEmbedder(),
      noSummarizer,
      { campaignId: CAMPAIGN, filename: "s12.md", content: SESSION },
      { deferSummary: true },
    );

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.embedded).toBe(result.chunkCount);
    expect(result.summarized).toBe(false);
    expect(result.document.filename).toBe("s12.md");
    expect(result.document.tokens).toBeGreaterThan(0);

    expect(countChunks(db)).toBe(result.chunkCount);
    expect(db.query("SELECT COUNT(*) AS n FROM embeddings").get()).toEqual({
      n: result.chunkCount,
    });
  });

  test("stores one normalised vector per chunk", async () => {
    const db = fresh();
    await ingestDocument(
      db,
      fakeEmbedder(),
      noSummarizer,
      { campaignId: CAMPAIGN, filename: "s12.md", content: SESSION },
      { deferSummary: true },
    );

    const rows = db.query("SELECT vec FROM embeddings").all() as Array<{ vec: Uint8Array }>;
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const vec = decodeVector(row.vec);
      expect(vec).toHaveLength(64);
      // Normalised vectors are unit length, so self-similarity is exactly 1.
      expect(dot(vec, vec)).toBeCloseTo(1, 5);
    }
  });

  test("pins the embedding model on first ingest and refuses a swap", async () => {
    const db = fresh();
    const input = { campaignId: CAMPAIGN, filename: "s12.md", content: SESSION };

    await ingestDocument(db, fakeEmbedder(64, "model-a"), noSummarizer, input, { deferSummary: true });

    await expect(
      ingestDocument(db, fakeEmbedder(64, "model-b"), noSummarizer, input, { deferSummary: true }),
    ).rejects.toThrow(/mismatch/i);
  });

  test("a differently-sized vector from the same model is also refused", async () => {
    const db = fresh();
    const input = { campaignId: CAMPAIGN, filename: "s12.md", content: SESSION };

    await ingestDocument(db, fakeEmbedder(64, "model-a"), noSummarizer, input, { deferSummary: true });

    await expect(
      ingestDocument(db, fakeEmbedder(128, "model-a"), noSummarizer, { ...input, content: SESSION + "Changed" }, { deferSummary: true }),
    ).rejects.toThrow(/mismatch/i);
  });

  test("re-ingesting a file replaces its chunks and embeddings", async () => {
    const db = fresh();
    const embedder = fakeEmbedder();

    await ingestDocument(
      db,
      embedder,
      noSummarizer,
      { campaignId: CAMPAIGN, filename: "s12.md", content: SESSION },
      { deferSummary: true },
    );
    await ingestDocument(
      db,
      embedder,
      noSummarizer,
      { campaignId: CAMPAIGN, filename: "s12.md", content: "# Session 12\n\nRewritten.\n" },
      { deferSummary: true },
    );

    expect(listDocuments(db, CAMPAIGN)).toHaveLength(1);
    // Orphaned embeddings would outnumber chunks; the cascade must keep them equal.
    expect(db.query("SELECT COUNT(*) AS n FROM embeddings").get()).toEqual({
      n: countChunks(db),
    });
  });

  test("normalises CRLF so offsets match the stored text", async () => {
    const db = fresh();
    const result = await ingestDocument(
      db,
      fakeEmbedder(),
      noSummarizer,
      { campaignId: CAMPAIGN, filename: "crlf.md", content: "# Title\r\n\r\nA line.\r\n\r\nAnother line.\r\n" },
      { deferSummary: true },
    );

    const doc = getDocument(db, result.document.id);
    expect(doc?.chunkCount).toBe(result.chunkCount);

    const rows = db.query("SELECT text FROM chunks").all() as Array<{ text: string }>;
    for (const row of rows) {
      expect(row.text).not.toContain("\r");
    }
  });

  test("rejects unsupported extensions before touching the database", async () => {
    const db = fresh();
    await expect(
      ingestDocument(
        db,
        fakeEmbedder(),
        noSummarizer,
        { campaignId: CAMPAIGN, filename: "notes.pdf", content: "x" },
        { deferSummary: true },
      ),
    ).rejects.toThrow(/Unsupported file type/);
    expect(listDocuments(db, CAMPAIGN)).toHaveLength(0);
  });

  test("rejects an empty document", async () => {
    const db = fresh();
    await expect(
      ingestDocument(
        db,
        fakeEmbedder(),
        noSummarizer,
        { campaignId: CAMPAIGN, filename: "empty.md", content: "   \n\n  \n" },
        { deferSummary: true },
      ),
    ).rejects.toThrow(/empty/i);
    expect(listDocuments(db, CAMPAIGN)).toHaveLength(0);
  });

  test("a document stays searchable when its summary is deferred", async () => {
    const db = fresh();
    await ingestDocument(
      db,
      fakeEmbedder(),
      noSummarizer,
      { campaignId: CAMPAIGN, filename: "s12.md", content: SESSION },
      { deferSummary: true },
    );

    const hits = db
      .query("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?")
      .all("tannery") as Array<{ rowid: number }>;

    expect(hits.length).toBeGreaterThan(0);
    expect(getDocument(db, 1)?.summary).toBe("");
  });
});

// ─── similarity helpers ───────────────────────────────────────────────────────

describe("normalize and dot", () => {
  test("normalize produces a unit vector", () => {
    const vec = normalize(Float32Array.from([3, 4]));
    expect(vec[0]!).toBeCloseTo(0.6, 6);
    expect(vec[1]!).toBeCloseTo(0.8, 6);
  });

  test("a zero vector is left alone rather than producing NaN", () => {
    const vec = normalize(new Float32Array(4));
    expect(Array.from(vec)).toEqual([0, 0, 0, 0]);
  });

  test("dot of orthogonal unit vectors is zero", () => {
    expect(dot(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
  });
});
