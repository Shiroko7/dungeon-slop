import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCHEMA } from "../db/schema.ts";
import { createCampaign } from "../campaign/campaigns.ts";
import { deferred } from "../test-fixtures.ts";
import { getDocument, listDocuments, openNotesDb } from "./db.ts";
import { backfillSummaries, hashContent, ingestDocument, retryDocument } from "./ingest.ts";
import { claimRevision, reserveRevision, revision } from "./revisions.ts";
import type { EmbeddingProvider, SummarizerProvider } from "./types.ts";

const opened: Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fresh() {
  const db = openNotesDb(":memory:");
  opened.push(db);
  createCampaign(db, { name: "Test campaign" });
  return db;
}
const input = { campaignId: 1, filename: "session.md", content: "# Session\n\nOld tannery." };
const embedder: EmbeddingProvider = { model: "test-embed", embed: async (texts) => texts.map(() => Float32Array.from([1, 2, 3])) };
const summarizer: SummarizerProvider = { name: "test", model: "test-summary", summarize: async (_filename, text) => ({ summary: text, entities: [] }) };
function indexSnapshot(db: Database) {
  return {
    docs: db.query("SELECT id, active_revision, content_hash, summary, entities, tokens FROM documents ORDER BY id").all(),
    chunks: db.query("SELECT * FROM chunks ORDER BY id").all(),
    vectors: db.query("SELECT * FROM embeddings ORDER BY chunk_id").all(),
  };
}

describe("recoverable note revisions", () => {
  test("unchanged completed uploads are no-ops, preserve identity, and never call providers", async () => {
    const db = fresh();
    await ingestDocument(db, embedder, summarizer, input);
    const before = indexSnapshot(db);
    const result = await ingestDocument(db,
      { ...embedder, embed: async () => { throw new Error("must not embed"); } },
      { ...summarizer, summarize: async () => { throw new Error("must not summarize"); } }, input);
    expect(result.unchanged).toBe(true);
    expect(result.embedded).toBe(0);
    expect(indexSnapshot(db)).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM note_revisions").get()).toEqual({ n: 1 });
  });

  for (const failure of ["timeout", "rate-limit", "count", "dimension", "nan", "zero", "model", "commit"]) {
    test(`replacement ${failure} failure preserves the full active index and summary`, async () => {
      const db = fresh();
      await ingestDocument(db, embedder, summarizer, input);
      const before = indexSnapshot(db);
      if (failure === "commit") db.run("CREATE TRIGGER reject_vector BEFORE INSERT ON embeddings BEGIN SELECT RAISE(ABORT, 'commit failed'); END");
      const bad: EmbeddingProvider = { model: failure === "model" ? "wrong" : embedder.model, embed: async (texts) => {
        if (failure === "timeout" || failure === "rate-limit") throw new Error(failure);
        if (failure === "count") return [];
        if (failure === "dimension") return texts.map(() => Float32Array.from([1, 2]));
        if (failure === "nan") return texts.map(() => Float32Array.from([NaN, 1, 2]));
        if (failure === "zero") return texts.map(() => new Float32Array(3));
        return embedder.embed(texts, "document");
      } };
      await expect(ingestDocument(db, bad, summarizer, { ...input, content: "Revised source" })).rejects.toThrow();
      expect(indexSnapshot(db)).toEqual(before);
      expect(getDocument(db, 1)?.indexStatus).toBe("failed");
      expect(revision(db, 1, 2)?.source_text).toBe("Revised source");
      expect(revision(db, 1, 1)?.source_text).toBe(input.content);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  }

  test("new failure is explicitly unindexed and retry uses the retained source", async () => {
    const db = fresh();
    await expect(ingestDocument(db, { ...embedder, embed: async () => { throw new Error("offline"); } }, summarizer, input)).rejects.toThrow("offline");
    expect(getDocument(db, 1)).toMatchObject({ activeRevision: 0, indexStatus: "failed", chunkCount: 0 });
    const retried = await retryDocument(db, embedder, summarizer, 1);
    expect(retried.document).toMatchObject({ id: 1, activeRevision: 1, summaryStatus: "ready" });
  });

  test("summary failure is partial success; retry summarizes exact saved source only", async () => {
    const db = fresh();
    const original = "# Original\r\n\r\nA source with CRLF.";
    const partial = await ingestDocument(db, embedder, { ...summarizer, summarize: async () => { throw new Error("summary unavailable"); } }, { ...input, content: original });
    expect(partial.document).toMatchObject({ indexStatus: "indexed", summaryStatus: "failed", summaryError: "summary unavailable" });
    const before = indexSnapshot(db).vectors;
    let seen = "";
    const retried = await retryDocument(db, { ...embedder, embed: async () => { throw new Error("must not embed"); } },
      { ...summarizer, summarize: async (_filename, text) => { seen = text; return { summary: "Recovered", entities: [] }; } }, partial.document.id);
    expect(seen).toBe(original);
    expect(retried.embedded).toBe(0);
    expect(retried.summarized).toBe(true);
    expect(indexSnapshot(db).vectors).toEqual(before);
  });

  test("older embedding completion cannot overwrite a newer accepted revision", async () => {
    const db = fresh();
    const gate = deferred<Float32Array[]>();
    const older = ingestDocument(db, { ...embedder, embed: () => gate.promise }, summarizer, input);
    const rejected = older.catch((error: unknown) => error);
    const newer = await ingestDocument(db, embedder, summarizer, { ...input, content: "Newer source" });
    gate.resolve([Float32Array.from([1, 2, 3])]);
    expect(await rejected).toBeInstanceOf(Error);
    expect(getDocument(db, newer.document.id)?.activeRevision).toBe(2);
    expect(getDocument(db, 1)?.summary).toBe("Newer source");
  });

  test("older summary cannot attach to a newer index", async () => {
    const db = fresh();
    const gate = deferred<{ summary: string; entities: string[] }>();
    const entered = deferred<void>();
    const older = ingestDocument(db, embedder, { ...summarizer, summarize: () => { entered.resolve(); return gate.promise; } }, input);
    const settled = older.catch((error: unknown) => error);
    await entered.promise;
    await ingestDocument(db, embedder, summarizer, { ...input, content: "New version" });
    gate.resolve({ summary: "Old summary", entities: [] });
    expect(await settled).toBeInstanceOf(Error);
    expect(getDocument(db, 1)?.summary).toBe("New version");
  });

  test("simultaneous duplicate uploads share a job and one embedding call", async () => {
    const db = fresh();
    const gate = deferred<Float32Array[]>();
    let calls = 0;
    const slow: EmbeddingProvider = { ...embedder, embed: () => { calls++; return gate.promise; } };
    const first = ingestDocument(db, slow, summarizer, input);
    const second = ingestDocument(db, slow, summarizer, input);
    gate.resolve([Float32Array.from([1, 2, 3])]);
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(listDocuments(db, 1)).toHaveLength(1);
  });

  test("cancellation prevents a late provider result from replacing the old index", async () => {
    const db = fresh();
    await ingestDocument(db, embedder, summarizer, input);
    const before = indexSnapshot(db);
    const gate = deferred<Float32Array[]>();
    const abort = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const upload = ingestDocument(db, { ...embedder, embed: (_texts, _kind, signal) => { providerSignal = signal; return gate.promise; } },
      summarizer, { ...input, content: "Cancelled source" }, { signal: abort.signal });
    const rejected = upload.catch((error: unknown) => error);
    abort.abort();
    expect(providerSignal?.aborted).toBe(true);
    gate.resolve([Float32Array.from([1, 2, 3])]);
    expect(await rejected).toBeInstanceOf(Error);
    expect(indexSnapshot(db)).toEqual(before);
    expect(getDocument(db, 1)?.indexStatus).toBe("cancelled");
  });

  test("backfill reads each document's source, skips other campaigns, and retains failures", async () => {
    const db = fresh();
    const other = createCampaign(db, { name: "Other" });
    await ingestDocument(db, embedder, summarizer, input, { deferSummary: true });
    await ingestDocument(db, embedder, summarizer, { ...input, filename: "later.md", content: "Later source" }, { deferSummary: true });
    await ingestDocument(db, embedder, summarizer, { ...input, campaignId: other.id }, { deferSummary: true });
    const seen: string[] = [];
    const count = await backfillSummaries(db, { ...summarizer, summarize: async (filename, text) => {
      seen.push(text);
      if (filename === "later.md") throw new Error("retry me");
      return { summary: "Done", entities: [] };
    } }, 1);
    expect(count).toBe(1);
    expect(seen).toEqual([input.content, "Later source"]);
    expect(listDocuments(db, other.id)[0]?.summary).toBe("");
    expect(getDocument(db, 2)?.summaryStatus).toBe("failed");
  });

  test("processing version changes require a replacement while document IDs stay stable", async () => {
    const db = fresh();
    await ingestDocument(db, embedder, summarizer, input);
    db.run("UPDATE note_revisions SET chunker_version = 'old'");
    const result = await ingestDocument(db, embedder, summarizer, input);
    expect(result.document.id).toBe(1);
    expect(result.document.activeRevision).toBe(2);
    expect(result.embedded).toBeGreaterThan(0);
  });

  test("an expired interrupted lease resumes; live leases reject duplicate processing", async () => {
    const db = fresh();
    const job = reserveRevision(db, { ...input, hash: hashContent(input.content) }, embedder.model);
    claimRevision(db, job);
    await expect(retryDocument(db, embedder, summarizer, job.doc_id)).rejects.toThrow(/already processing/);
    db.run("UPDATE note_revisions SET lease_until = 0");
    expect((await retryDocument(db, embedder, summarizer, job.doc_id)).summarized).toBe(true);
  });

  test("a busy summary lease is partial success and does not stop backlog processing", async () => {
    const db = fresh();
    await ingestDocument(db, embedder, summarizer, input, { deferSummary: true });
    await ingestDocument(db, embedder, summarizer, { ...input, filename: "second.md" }, { deferSummary: true });
    claimRevision(db, revision(db, 1, 1)!, true);
    const retry = await retryDocument(db, embedder, summarizer, 1);
    expect(retry).toMatchObject({ embedded: 0, summarized: false, document: { activeIndexStatus: "indexed", summaryStatus: "processing" } });
    expect(await backfillSummaries(db, summarizer, 1)).toBe(1);
    expect(getDocument(db, 2)?.summaryStatus).toBe("ready");
  });
});

test("v6 migration and failed reindex preserve notes, maps, chats and authorship", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-m14-"));
  const path = join(dir, "legacy.sqlite");
  let db = new Database(path);
  try {
    const legacy = SCHEMA.replace(/CREATE TABLE IF NOT EXISTS note_revisions \([\s\S]*?\);/, "")
      .replace(/  (active_revision|latest_revision|source_revision)[^\n]*\n/g, "");
    db.run(legacy);
    createCampaign(db, { name: "Preserved campaign" });
    db.run("INSERT INTO documents (id, campaign_id, filename, uploaded_at, content_hash, summary) VALUES (1, 1, 'session.md', 1, 'legacy', 'Legacy summary')");
    db.run("INSERT INTO chunks (id, doc_id, ordinal, heading_path, text, tokens, start_offset, end_offset) VALUES (1, 1, 0, '', 'Old tannery', 3, 0, 11)");
    db.run("INSERT INTO embeddings (chunk_id, vec) VALUES (1, ?)", [new Uint8Array(Float32Array.from([1, 2, 3]).buffer)]);
    db.run("INSERT INTO documents (id, campaign_id, filename, uploaded_at, content_hash) VALUES (10, 1, 'incomplete.md', 1, 'incomplete')");
    db.run("INSERT INTO chunks (id, doc_id, ordinal, heading_path, text, tokens, start_offset, end_offset) VALUES (10, 10, 0, '', 'Missing vector', 3, 0, 14)");
    db.run("INSERT INTO dungeons (id, campaign_id, name, geometry, created_at, updated_at) VALUES (1, 1, 'Map', '{}', 1, 1)");
    db.run("INSERT INTO room_notes VALUES (1, 1, 'Room', '{}', 1)");
    db.run("INSERT INTO chats (id, campaign_id, title, created_at, updated_at) VALUES (1, 1, 'Chat', 1, 1)");
    db.run("INSERT INTO meta VALUES ('embedding_model', 'test-embed:3')");
    db.close();
    db = openNotesDb(path);
    expect(getDocument(db, 1)).toMatchObject({ sourceAvailable: false, activeRevision: 1, activeIndexStatus: "indexed", summary: "Legacy summary" });
    expect(getDocument(db, 10)).toMatchObject({ sourceAvailable: false, activeIndexStatus: "failed", summaryStatus: "source-required" });
    const before = indexSnapshot(db);
    await expect(retryDocument(db, embedder, summarizer, 1, { force: true })).rejects.toThrow(/Reupload/);
    await expect(ingestDocument(db, { ...embedder, embed: async () => { throw new Error("failed reindex"); } }, summarizer, input)).rejects.toThrow();
    expect(indexSnapshot(db)).toEqual(before);
    expect(db.query("SELECT name FROM dungeons").get()).toEqual({ name: "Map" });
    expect(db.query("SELECT title FROM chats").get()).toEqual({ title: "Chat" });
    expect(db.query("SELECT name FROM room_notes").get()).toEqual({ name: "Room" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    db = openNotesDb(path);
    expect((await retryDocument(db, embedder, summarizer, 1)).document.id).toBe(1);
    const newFile = reserveRevision(db, { ...input, filename: "new.md", hash: hashContent(input.content) }, embedder.model);
    expect(getDocument(db, newFile.doc_id)).toMatchObject({ activeRevision: 0, latestRevision: 1, indexStatus: "pending" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (error) {
      // Bun/Windows can retain SQLite mapping handles until GC/process exit.
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    }
  }
});
