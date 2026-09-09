import type { Database } from "bun:sqlite";
import { chunkDocument, estimateTokens } from "./chunker.ts";
import {
  assertEmbeddingModel,
  documentsMissingSummary,
  getDocument,
  replaceDocument,
  setDocumentSummary,
  storeEmbeddings,
} from "./db.ts";
import { normalize } from "./embeddings.ts";
import { SUPPORTED_EXTENSIONS, isSupportedFile } from "./shared.ts";
import { summarizeSequentially } from "./summarize.ts";
import type { Chunk, EmbeddingProvider, NoteDocument, SummarizerProvider } from "./types.ts";

export { SUPPORTED_EXTENSIONS, isSupportedFile } from "./shared.ts";

export function hashContent(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * What actually gets embedded. The heading breadcrumb is prepended rather than
 * left in its own column because the vector has to carry it — a chunk reading
 * "three goblins waited at the junction" is near-meaningless on its own, and
 * near-unambiguous under "Session 12 › The Sewers › Ambush". The column stays
 * for display and for BM25 to match separately.
 */
export function embeddingText(chunk: Chunk): string {
  return chunk.headingPath === "" ? chunk.text : `${chunk.headingPath}\n\n${chunk.text}`;
}

export interface IngestInput {
  /** The campaign that will own the document. Notes are never global. */
  campaignId: number;
  filename: string;
  content: string;
}

export interface IngestResult {
  document: NoteDocument;
  chunkCount: number;
  embedded: number;
  summarized: boolean;
}

export interface IngestOptions {
  /** Skip the summary pass so a bulk upload is not serialised behind it. */
  deferSummary?: boolean;
}

/**
 * Index one document end to end: chunk, store, embed, summarize.
 *
 * Ordering is deliberate. Chunks and their embeddings are written before the
 * summary is requested, so a failure in the (network-bound, model-dependent)
 * summary step leaves a document that is fully searchable and merely missing
 * its manifest line — recoverable by `backfillSummaries`. The reverse ordering
 * would leave a document that is described but not searchable, which is worse:
 * the agent would see it on the manifest and be unable to read it.
 */
export async function ingestDocument(
  db: Database,
  embedder: EmbeddingProvider,
  summarizer: SummarizerProvider,
  input: IngestInput,
  options: IngestOptions = {},
): Promise<IngestResult> {
  if (!isSupportedFile(input.filename)) {
    throw new Error(
      `Unsupported file type: "${input.filename}". Expected one of ${SUPPORTED_EXTENSIONS.join(", ")}`,
    );
  }

  const content = input.content.replace(/\r\n/g, "\n");
  if (content.trim() === "") {
    throw new Error(`"${input.filename}" is empty`);
  }

  const chunks = chunkDocument(content);
  if (chunks.length === 0) {
    throw new Error(`"${input.filename}" produced no chunks`);
  }

  const { docId, chunkIds } = replaceDocument(db, {
    campaignId: input.campaignId,
    filename: input.filename,
    contentHash: hashContent(content),
    tokens: estimateTokens(content),
    chunks,
  });

  const vectors = await embedder.embed(chunks.map(embeddingText), "document");
  if (vectors.length !== chunkIds.length) {
    throw new Error(
      `Embedding count mismatch for "${input.filename}": ${vectors.length} vectors for ${chunkIds.length} chunks`,
    );
  }

  const first = vectors[0];
  if (first !== undefined) {
    assertEmbeddingModel(db, embedder.model, first.length);
  }

  storeEmbeddings(
    db,
    chunkIds.map((chunkId, i) => ({ chunkId, vec: normalize(vectors[i]!) })),
  );

  let summarized = false;
  if (options.deferSummary !== true) {
    const { summary, entities } = await summarizer.summarize(input.filename, content);
    setDocumentSummary(db, docId, summary, entities);
    summarized = true;
  }

  const document = getDocument(db, docId);
  if (document === null) {
    throw new Error(`Document ${docId} vanished immediately after insert`);
  }

  return { document, chunkCount: chunks.length, embedded: vectors.length, summarized };
}

/**
 * Summarize every indexed document that has no manifest line yet. Safe to
 * re-run: it only ever picks up what is still missing, so a run interrupted
 * halfway through resumes rather than starting over.
 */
export async function backfillSummaries(
  db: Database,
  summarizer: SummarizerProvider,
  readContent: (doc: NoteDocument) => Promise<string> | string,
  onProgress?: (done: number, total: number) => void,
  campaignId?: number,
): Promise<number> {
  const pending = documentsMissingSummary(db, campaignId);
  if (pending.length === 0) return 0;

  const inputs = [];
  for (const doc of pending) {
    inputs.push({ docId: doc.id, filename: doc.filename, text: await readContent(doc) });
  }

  const summaries = await summarizeSequentially(summarizer, inputs, onProgress);
  for (const [docId, summary] of summaries) {
    setDocumentSummary(db, docId, summary.summary, summary.entities);
  }
  return summaries.size;
}
