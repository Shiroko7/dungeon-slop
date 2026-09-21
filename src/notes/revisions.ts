import type { Database } from "bun:sqlite";
import { assertEmbeddingModel, encodeVector } from "./db.ts";
import { CHUNKER_VERSION } from "./shared.ts";
import type { Chunk, DocumentSummary } from "./types.ts";

export interface NoteRevision {
  doc_id: number;
  revision: number;
  source_text: string | null;
  content_hash: string;
  chunker_version: string;
  embedding_model: string;
  index_status: string;
  summary_status: string;
  worker_token: string | null;
  lease_until: number;
}

export function revision(db: Database, docId: number, rev: number): NoteRevision | null {
  return db.query("SELECT * FROM note_revisions WHERE doc_id = ? AND revision = ?")
    .get(docId, rev) as NoteRevision | null;
}

/** Reserve intent before any network wait. Only this latest intent may commit. */
export function reserveRevision(
  db: Database,
  input: { campaignId: number; filename: string; content: string; hash: string },
  model: string,
  force = false,
): NoteRevision {
  return db.transaction(() => {
    db.run(`INSERT INTO documents (campaign_id, filename, uploaded_at, content_hash, active_revision, latest_revision)
      VALUES (?, ?, ?, '', 0, 0) ON CONFLICT(campaign_id, filename) DO NOTHING`,
      [input.campaignId, input.filename, Date.now()]);
    const doc = db.query(`SELECT id, latest_revision FROM documents
      WHERE campaign_id = ? AND filename = ?`).get(input.campaignId, input.filename) as { id: number; latest_revision: number };
    const prior = revision(db, doc.id, doc.latest_revision);
    if (!force && prior && prior.content_hash === input.hash &&
        prior.chunker_version === CHUNKER_VERSION && prior.embedding_model === model &&
        prior.source_text !== null) return prior;

    const next = doc.latest_revision + 1;
    db.run(`INSERT INTO note_revisions
      (doc_id, revision, source_text, content_hash, chunker_version, embedding_model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [doc.id, next, input.content, input.hash, CHUNKER_VERSION, model, Date.now()]);
    db.run("UPDATE documents SET latest_revision = ? WHERE id = ?", [next, doc.id]);
    // Keep exact sources for the active and newest attempted revision only.
    // Prior attempts retain small diagnostic receipts, not unbounded source copies.
    db.run(`UPDATE note_revisions SET source_text = NULL WHERE doc_id = ?
      AND revision <> ? AND revision <> (SELECT active_revision FROM documents WHERE id = ?)`,
      [doc.id, next, doc.id]);
    return revision(db, doc.id, next)!;
  })();
}

export class SupersededRevision extends Error {
  constructor() { super("A newer upload replaced this attempt. Its result was not applied."); }
}

export function assertLatest(db: Database, job: NoteRevision): void {
  const row = db.query("SELECT latest_revision FROM documents WHERE id = ?").get(job.doc_id) as { latest_revision: number } | null;
  if (!row || row.latest_revision !== job.revision) throw new SupersededRevision();
}

/** A lease prevents duplicate work across requests/processes; expires after a crash. */
export function claimRevision(db: Database, job: NoteRevision, summary = false): string | null {
  if (!summary) assertLatest(db, job);
  const token = crypto.randomUUID();
  const result = db.run(`UPDATE note_revisions SET worker_token = ?, lease_until = ?,
      ${summary ? "summary_status = 'processing', summary_error = NULL" : "index_status = 'indexing', index_error = NULL"}
      WHERE doc_id = ? AND revision = ? AND (worker_token IS NULL OR lease_until < ?)
      AND ${summary ? "summary_status <> 'ready'" : "index_status <> 'indexed'"}`,
    [token, Date.now() + 360_000, job.doc_id, job.revision, Date.now()]);
  if (!result.changes) {
    const current = revision(db, job.doc_id, job.revision);
    if (summary ? current?.summary_status === "ready" : current?.index_status === "indexed") return null;
    throw new Error("This note is already processing. Retry after it finishes; interrupted work unlocks within six minutes.");
  }
  return token;
}

export function failRevision(db: Database, job: NoteRevision, token: string, error: unknown, summary = false, cancelled = false): void {
  const message = (error instanceof Error ? error.message : "Processing failed").slice(0, 1000);
  db.run(`UPDATE note_revisions SET
    ${summary ? "summary_status = ?, summary_error = ?" : "index_status = ?, index_error = ?"},
    worker_token = NULL, lease_until = 0
    WHERE doc_id = ? AND revision = ? AND worker_token = ?`,
    [cancelled ? "cancelled" : "failed", message, job.doc_id, job.revision, token]);
}

/** No provider calls inside this transaction. FTS triggers and vectors swap together. */
export function commitIndex(db: Database, job: NoteRevision, token: string, chunks: Chunk[], vectors: Float32Array[], tokens: number): void {
  db.transaction(() => {
    assertLatest(db, job);
    if (revision(db, job.doc_id, job.revision)?.worker_token !== token) throw new SupersededRevision();
    assertEmbeddingModel(db, job.embedding_model, vectors[0]!.length);
    db.run("DELETE FROM chunks WHERE doc_id = ?", [job.doc_id]);
    const insert = db.prepare(`INSERT INTO chunks
      (doc_id, source_revision, ordinal, heading_path, text, tokens, start_offset, end_offset)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);
    for (const [i, chunk] of chunks.entries()) {
      const row = insert.get(job.doc_id, job.revision, chunk.ordinal, chunk.headingPath,
        chunk.text, chunk.tokens, chunk.startOffset, chunk.endOffset) as { id: number };
      db.run("INSERT INTO embeddings (chunk_id, vec) VALUES (?, ?)", [row.id, encodeVector(vectors[i]!)]);
    }
    db.run(`UPDATE documents SET active_revision = ?, content_hash = ?, tokens = ?,
      uploaded_at = ?, summary = '', entities = '[]' WHERE id = ?`,
      [job.revision, job.content_hash, tokens, Date.now(), job.doc_id]);
    db.run(`UPDATE note_revisions SET index_status = 'indexed', index_error = NULL,
      dimensions = ?, worker_token = NULL, lease_until = 0 WHERE doc_id = ? AND revision = ?`,
      [vectors[0]!.length, job.doc_id, job.revision]);
    db.run("UPDATE note_revisions SET source_text = NULL WHERE doc_id = ? AND revision <> ?", [job.doc_id, job.revision]);
  })();
}

export function commitSummary(db: Database, job: NoteRevision, token: string, result: DocumentSummary, model: string): void {
  db.transaction(() => {
    const update = db.run(`UPDATE documents SET summary = ?, entities = ?
      WHERE id = ? AND active_revision = ? AND EXISTS
        (SELECT 1 FROM note_revisions WHERE doc_id = ? AND revision = ? AND worker_token = ?)`,
      [result.summary, JSON.stringify(result.entities), job.doc_id, job.revision, job.doc_id, job.revision, token]);
    if (!update.changes) throw new SupersededRevision();
    db.run(`UPDATE note_revisions SET summary_status = 'ready', summary_error = NULL,
      summary_model = ?, worker_token = NULL, lease_until = 0 WHERE doc_id = ? AND revision = ?`,
      [model, job.doc_id, job.revision]);
  })();
}
