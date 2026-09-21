import type { Database } from "bun:sqlite";
import type { NoteReader } from "./retrieval-types.ts";

export class NoteAccessError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

/** Never resolve an old citation against current text, even when filenames match. */
export function readNote(db: Database, campaignId: number, documentId: number, revision: number, chunkId?: number): NoteReader {
  return db.transaction(() => readSnapshot(db, campaignId, documentId, revision, chunkId))();
}

function readSnapshot(db: Database, campaignId: number, documentId: number, revision: number, chunkId?: number): NoteReader {
  const row = db.query(`SELECT d.filename, d.active_revision, r.content_hash,
      r.index_status, r.source_text FROM documents d JOIN note_revisions r ON r.doc_id = d.id
      WHERE d.campaign_id = ? AND d.id = ? AND r.revision = ?`)
    .get(campaignId, documentId, revision) as {
      filename: string; active_revision: number; content_hash: string; index_status: string; source_text: string | null;
    } | null;
  if (!row) throw new NoteAccessError("This source does not exist in this campaign, or has been deleted.", 404, "source_missing");
  if (row.source_text === null && row.active_revision !== revision) {
    throw new NoteAccessError("This source revision is no longer retained. Open the note library to choose its current version; this citation was not redirected.", 410, "revision_removed");
  }
  const chunks = db.query(`SELECT id, ordinal, heading_path AS headingPath,
    start_offset AS startOffset, end_offset AS endOffset, text FROM chunks
    WHERE doc_id = ? AND source_revision = ? ORDER BY ordinal`).all(documentId, revision) as NoteReader["chunks"];
  if (chunkId !== undefined && !chunks.some((chunk) => chunk.id === chunkId)) {
    throw new NoteAccessError("This passage is no longer available at the cited revision.", 410, "passage_removed");
  }
  return { campaignId, documentId, filename: row.filename, revision, activeRevision: row.active_revision,
    contentHash: row.content_hash, indexStatus: row.index_status, source: row.source_text, chunks,
    notice: row.source_text === null ? "Original source unavailable for this legacy note. Showing stored chunks, which may overlap; reupload to restore the full document."
      : row.active_revision !== revision ? "This is a stored attempt, not the active search revision." : null };
}
