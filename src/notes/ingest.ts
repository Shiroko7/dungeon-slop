import type { Database } from "bun:sqlite";
import { chunkDocument, estimateTokens } from "./chunker.ts";
import { documentsMissingSummary, getDocument, getMeta } from "./db.ts";
import { normalize } from "./embeddings.ts";
import { MAX_NOTE_FILE_BYTES, SUPPORTED_EXTENSIONS, isSupportedFile } from "./shared.ts";
import { SummarySchema } from "./summary-spec.ts";
import { assertLatest, claimRevision, commitIndex, commitSummary, failRevision, reserveRevision, revision, type NoteRevision } from "./revisions.ts";
import { noteWork } from "./work-limit.ts";
import type { Chunk, EmbeddingProvider, NoteDocument, SummarizerProvider } from "./types.ts";

export { SUPPORTED_EXTENSIONS, isSupportedFile } from "./shared.ts";

export function hashContent(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function embeddingText(chunk: Chunk): string {
  return chunk.headingPath === "" ? chunk.text : `${chunk.headingPath}\n\n${chunk.text}`;
}

export interface IngestInput { campaignId: number; filename: string; content: string }
export interface IngestResult {
  document: NoteDocument;
  chunkCount: number;
  embedded: number;
  summarized: boolean;
  unchanged: boolean;
}
export interface IngestOptions {
  deferSummary?: boolean;
  signal?: AbortSignal;
  force?: boolean;
}

const running = new WeakMap<Database, Map<string, Promise<IngestResult>>>();
const summaries = new WeakMap<Database, Map<string, Promise<boolean>>>();

function taskSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(300_000)]);
}

function validateVectors(vectors: Float32Array[], expected: number): void {
  if (vectors.length !== expected) throw new Error(`Embedding count mismatch: ${vectors.length} vectors for ${expected} chunks`);
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions < 1 || dimensions > 65_536) throw new Error("Invalid embedding dimensions");
  for (const vector of vectors) {
    if (vector.length !== dimensions) throw new Error("Embedding dimensions differ within the document");
    if (vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) {
      throw new Error("Embedding contains non-finite values or is a zero vector");
    }
  }
}

/** Exact source is saved before provider work; the prior active index is untouched. */
export async function ingestDocument(
  db: Database, embedder: EmbeddingProvider, summarizer: SummarizerProvider,
  input: IngestInput, options: IngestOptions = {},
): Promise<IngestResult> {
  options.signal?.throwIfAborted();
  if (!isSupportedFile(input.filename)) throw new Error(`Unsupported file type: expected ${SUPPORTED_EXTENSIONS.join(", ")}`);
  if (!input.content.trim()) throw new Error(`"${input.filename}" is empty`);
  if (new TextEncoder().encode(input.content).byteLength > MAX_NOTE_FILE_BYTES) throw new Error("File exceeds the 5 MiB limit");
  const job = reserveRevision(db, { ...input, hash: hashContent(input.content) }, embedder.model, options.force);
  return processRevision(db, embedder, summarizer, job, options);
}

async function processRevision(
  db: Database, embedder: EmbeddingProvider, summarizer: SummarizerProvider,
  job: NoteRevision, options: IngestOptions,
): Promise<IngestResult> {
  let tasks = running.get(db);
  if (!tasks) { tasks = new Map(); running.set(db, tasks); }
  const key = `${job.doc_id}:${job.revision}`;
  const existing = tasks.get(key);
  if (existing) return existing;
  const signal = taskSignal(options.signal);
  const task = (async () => {
    let embedded = 0;
    const unchanged = job.index_status === "indexed" && job.summary_status === "ready";
    if (job.index_status !== "indexed") {
      await noteWork.run(signal, async () => {
        const token = claimRevision(db, job);
        if (token === null) return;
        try {
          if (job.source_text === null) throw new Error("Original source unavailable. Reupload this file to index it.");
          if (job.embedding_model !== embedder.model) throw new Error("Embedding model changed. Reupload or reindex with the original model.");
          const stamp = getMeta(db, "embedding_model");
          if (stamp && stamp.slice(0, stamp.lastIndexOf(":")) !== embedder.model) {
            throw new Error(`Embedding model mismatch: index uses ${stamp}. Switch back to that model, then retry this note.`);
          }
          // Offsets address LF-normalized source; retain the exact original for
          // summaries, reindexing, and the future document reader.
          const content = job.source_text.replace(/\r\n/g, "\n");
          const chunks = chunkDocument(content);
          if (!chunks.length) throw new Error("Document produced no chunks");
          if (chunks.length > 5000) throw new Error("Document exceeds 5,000 chunks. Split it into smaller files.");
          const vectors = await embedder.embed(chunks.map(embeddingText), "document", signal);
          signal.throwIfAborted();
          validateVectors(vectors, chunks.length);
          commitIndex(db, job, token, chunks, vectors.map(normalize), estimateTokens(content));
          embedded = vectors.length;
        } catch (error) {
          failRevision(db, job, token, error, false, signal.aborted);
          throw error;
        }
      });
    } else {
      assertLatest(db, job);
    }
    if (!options.deferSummary) await summarizeRevision(db, summarizer, job.doc_id, signal);
    assertLatest(db, job);
    const document = getDocument(db, job.doc_id);
    if (!document) throw new Error("This note was removed while processing.");
    return { document, chunkCount: document.chunkCount, embedded,
      summarized: document.summaryStatus === "ready", unchanged };
  })();
  tasks.set(key, task);
  try { return await task; } finally { tasks.delete(key); }
}

/** A summary failure is partial success, never a failed indexing replacement. */
export async function summarizeRevision(db: Database, summarizer: SummarizerProvider, docId: number, parentSignal?: AbortSignal): Promise<boolean> {
  const doc = getDocument(db, docId);
  if (!doc || doc.activeRevision === 0) return false;
  const job = revision(db, docId, doc.activeRevision);
  if (!job || job.index_status !== "indexed") return false;
  if (job.summary_status === "ready") return true;
  if (job.source_text === null) return false;
  let tasks = summaries.get(db);
  if (!tasks) { tasks = new Map(); summaries.set(db, tasks); }
  const key = `${docId}:${job.revision}`;
  if (tasks.has(key)) return tasks.get(key)!;
  const signal = taskSignal(parentSignal);
  const task = noteWork.run(signal, async () => {
    let token: string | null = null;
    try {
      token = claimRevision(db, job, true);
      if (token === null) return true;
      const result = SummarySchema.parse(await summarizer.summarize(doc.filename, job.source_text!, signal));
      signal.throwIfAborted();
      if (!result.summary.trim()) throw new Error("Provider returned an empty summary");
      commitSummary(db, job, token, result, `${summarizer.name}/${summarizer.model}`);
      return true;
    } catch (error) {
      if (token !== null) failRevision(db, job, token, error, true, signal.aborted);
      return false;
    }
  });
  tasks.set(key, task);
  try { return await task; } finally { tasks.delete(key); }
}

/** Retry the latest stored source, including after a server restart. */
export async function retryDocument(db: Database, embedder: EmbeddingProvider, summarizer: SummarizerProvider,
  docId: number, options: IngestOptions = {}): Promise<IngestResult> {
  const doc = getDocument(db, docId);
  if (!doc) throw new Error("Note no longer exists");
  const job = revision(db, docId, doc.latestRevision);
  if (!job?.source_text) throw new Error("Original source unavailable. Reupload this file; its existing search data is preserved.");
  if (options.force) return ingestDocument(db, embedder, summarizer,
    { campaignId: doc.campaignId, filename: doc.filename, content: job.source_text }, options);
  return processRevision(db, embedder, summarizer, job, options);
}

/** Reads one stored source at a time, including backlog outside the latest batch. */
export async function backfillSummaries(db: Database, summarizer: SummarizerProvider, campaignId: number,
  onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<number> {
  const pending = documentsMissingSummary(db, campaignId);
  let done = 0;
  for (const [i, doc] of pending.entries()) {
    signal?.throwIfAborted();
    if (await summarizeRevision(db, summarizer, doc.id, signal)) done++;
    onProgress?.(i + 1, pending.length);
  }
  return done;
}
