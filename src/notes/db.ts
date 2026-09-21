import type { Database } from "bun:sqlite";
import { openAppDb, DEFAULT_DB_PATH } from "../db/open.ts";
import type { Chunk, NoteDocument } from "./types.ts";

export { DEFAULT_DB_PATH };

/**
 * The notes tables are part of the application schema — see `src/db/schema.ts`,
 * where they sit alongside campaigns, dungeons and chats so a campaign delete
 * can cascade through all of them at once.
 */
export const openNotesDb = openAppDb;

// ─── meta ─────────────────────────────────────────────────────────────────────

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

/**
 * Vectors from different models are not comparable, and mixing them produces
 * silently wrong rankings rather than an error. Pin the model on first write
 * and refuse to mix afterwards.
 *
 * Deliberately global rather than per-campaign: one index, one vector space.
 * Letting campaigns diverge would mean re-embedding on every move between them.
 */
export function assertEmbeddingModel(db: Database, model: string, dimensions: number): void {
  const stamp = `${model}:${dimensions}`;
  const existing = getMeta(db, "embedding_model");

  if (existing === null) {
    setMeta(db, "embedding_model", stamp);
    return;
  }
  if (existing !== stamp) {
    throw new Error(
      `Embedding model mismatch: index was built with "${existing}" but "${stamp}" was supplied. ` +
        `Switch back to the indexed model, then use Retry or Reindex on the affected note. ` +
        `Your existing notes and campaign data have been preserved.`,
    );
  }
}

// ─── vectors ──────────────────────────────────────────────────────────────────

export function encodeVector(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  // Copy rather than view: SQLite's buffer is not guaranteed 4-byte aligned,
  // and a misaligned Float32Array view throws.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

// ─── documents ────────────────────────────────────────────────────────────────

interface DocumentRow {
  id: number;
  campaign_id: number;
  filename: string;
  uploaded_at: number;
  summary: string;
  entities: string;
  tokens: number;
  chunk_count: number;
  active_revision: number;
  latest_revision: number;
  source_available: number;
  retry_source_available: number;
  active_index_status: string | null;
  index_status: string | null;
  index_error: string | null;
  summary_status: string | null;
  summary_error: string | null;
  embedding_model: string | null;
}

function toDocument(row: DocumentRow): NoteDocument {
  let entities: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.entities);
    if (Array.isArray(parsed)) entities = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    // A malformed entity list should degrade the manifest, never break a query.
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    filename: row.filename,
    uploadedAt: row.uploaded_at,
    summary: row.summary,
    entities,
    tokens: row.tokens,
    chunkCount: row.chunk_count,
    activeRevision: row.active_revision,
    latestRevision: row.latest_revision,
    sourceAvailable: Boolean(row.source_available),
    retrySourceAvailable: Boolean(row.retry_source_available),
    activeIndexStatus: row.active_index_status ?? 'unindexed',
    indexStatus: row.index_status ?? 'legacy',
    indexError: row.index_error,
    summaryStatus: row.summary_status ?? (row.active_revision === 0 ? 'pending' : row.summary ? 'ready' : 'source-required'),
    summaryError: row.summary_error,
    embeddingModel: row.embedding_model,
  };
}

const DOC_SELECT = `
  SELECT d.id, d.campaign_id, d.filename, d.uploaded_at, d.summary, d.entities, d.tokens,
         d.active_revision, d.latest_revision,
         a.source_text IS NOT NULL AS source_available,
         r.source_text IS NOT NULL AS retry_source_available,
         a.index_status AS active_index_status,
         r.index_status, r.index_error, a.summary_status, a.summary_error, a.embedding_model,
         (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunk_count
  FROM documents d
  LEFT JOIN note_revisions a ON a.doc_id = d.id AND a.revision = d.active_revision
  LEFT JOIN note_revisions r ON r.doc_id = d.id AND r.revision = d.latest_revision
`;

export function listDocuments(db: Database, campaignId: number): NoteDocument[] {
  const rows = db
    .query(`${DOC_SELECT} WHERE d.campaign_id = ? ORDER BY d.filename`)
    .all(campaignId) as DocumentRow[];
  return rows.map(toDocument);
}

export function getDocument(db: Database, id: number): NoteDocument | null {
  const row = db.query(`${DOC_SELECT} WHERE d.id = ?`).get(id) as DocumentRow | null;
  return row === null ? null : toDocument(row);
}

/**
 * Scoped to a campaign, because the same file legitimately exists in two of
 * them — a shared bestiary, a house-rules doc — and a global hash lookup would
 * make the second upload look like a duplicate of the first.
 */
export function findDocumentByHash(
  db: Database,
  campaignId: number,
  hash: string,
): number | null {
  const row = db
    .query("SELECT id FROM documents WHERE campaign_id = ? AND content_hash = ?")
    .get(campaignId, hash) as { id: number } | null;
  return row?.id ?? null;
}

export function deleteDocument(db: Database, id: number): void {
  db.run("DELETE FROM documents WHERE id = ?", [id]);
}

export function documentCampaignId(db: Database, id: number): number | null {
  const row = db.query("SELECT campaign_id FROM documents WHERE id = ?").get(id) as
    | { campaign_id: number }
    | null;
  return row?.campaign_id ?? null;
}

/**
 * Legacy fixture helper for low-level database tests. Production uploads must
 * use ingestDocument, which stages vectors before replacing the active index
 * and preserves document identity and retryable source revisions.
 */
export function replaceDocument(
  db: Database,
  input: {
    campaignId: number;
    filename: string;
    contentHash: string;
    tokens: number;
    chunks: Chunk[];
  },
): { docId: number; chunkIds: number[] } {
  const run = db.transaction(() => {
    db.run("DELETE FROM documents WHERE campaign_id = ? AND filename = ?", [
      input.campaignId,
      input.filename,
    ]);
    db.run(
      "INSERT INTO documents (campaign_id, filename, uploaded_at, content_hash, tokens) VALUES (?, ?, ?, ?, ?)",
      [input.campaignId, input.filename, Date.now(), input.contentHash, input.tokens],
    );

    const docId = Number(
      (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
    );

    const insert = db.prepare(
      `INSERT INTO chunks (doc_id, ordinal, heading_path, text, tokens, start_offset, end_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    );

    const chunkIds: number[] = [];
    for (const chunk of input.chunks) {
      const row = insert.get(
        docId,
        chunk.ordinal,
        chunk.headingPath,
        chunk.text,
        chunk.tokens,
        chunk.startOffset,
        chunk.endOffset,
      ) as { id: number };
      chunkIds.push(row.id);
    }

    return { docId, chunkIds };
  });

  return run();
}

export function setDocumentSummary(
  db: Database,
  docId: number,
  summary: string,
  entities: string[],
): void {
  db.run("UPDATE documents SET summary = ?, entities = ? WHERE id = ?", [
    summary,
    JSON.stringify(entities),
    docId,
  ]);
}

export function storeEmbeddings(
  db: Database,
  rows: Array<{ chunkId: number; vec: Float32Array }>,
): void {
  const insert = db.prepare(
    "INSERT INTO embeddings (chunk_id, vec) VALUES (?, ?) " +
      "ON CONFLICT(chunk_id) DO UPDATE SET vec = excluded.vec",
  );
  db.transaction(() => {
    for (const row of rows) insert.run(row.chunkId, encodeVector(row.vec));
  })();
}

/** Chunks across every campaign, or within one when `campaignId` is given. */
export function countChunks(db: Database, campaignId?: number): number {
  if (campaignId === undefined) {
    return (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  }
  return (
    db
      .query(
        `SELECT COUNT(*) AS n FROM chunks c
         JOIN documents d ON d.id = c.doc_id WHERE d.campaign_id = ?`,
      )
      .get(campaignId) as { n: number }
  ).n;
}

/** Documents that were indexed but never summarized — the manifest gap. */
export function documentsMissingSummary(db: Database, campaignId?: number): NoteDocument[] {
  const rows =
    campaignId === undefined
      ? (db.query(`${DOC_SELECT} WHERE d.summary = '' ORDER BY d.id`).all() as DocumentRow[])
      : (db
          .query(`${DOC_SELECT} WHERE d.summary = '' AND d.campaign_id = ? ORDER BY d.id`)
          .all(campaignId) as DocumentRow[]);
  return rows.map(toDocument);
}
