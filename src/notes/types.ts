/** A contiguous span of a source document, addressed by character offset. */
export interface Chunk {
  /** Position within the document, 0-based. */
  ordinal: number;
  /** Breadcrumb of enclosing markdown headings, e.g. "Session 12 › The Sewers". */
  headingPath: string;
  /** Always equal to `source.slice(startOffset, endOffset)`. */
  text: string;
  /** Estimated, not exact — see `estimateTokens`. */
  tokens: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkOptions {
  /** Preferred chunk size. Chunks close under this are flushed. */
  targetTokens?: number;
  /** How much of the previous chunk to repeat at the head of the next. */
  overlapTokens?: number;
  /** Hard ceiling. A single block above this is split by sentence, then by character. */
  maxTokens?: number;
}

/** What one uploaded file becomes after the summarization pass. */
export interface DocumentSummary {
  /** One line, written for a manifest the agent reads before searching. */
  summary: string;
  /** Proper nouns worth matching on: people, places, factions, items. */
  entities: string[];
}

export interface NoteDocument {
  id: number;
  /** The campaign that owns this document. Notes are never global. */
  campaignId: number;
  filename: string;
  uploadedAt: number;
  summary: string;
  entities: string[];
  tokens: number;
  chunkCount: number;
  activeRevision: number;
  latestRevision: number;
  sourceAvailable: boolean;
  retrySourceAvailable: boolean;
  activeIndexStatus: string;
  indexStatus: string;
  indexError: string | null;
  summaryStatus: string;
  summaryError: string | null;
  embeddingModel: string | null;
}

/** A retrieval hit, carrying enough provenance for the agent to cite it. */
export interface SearchHit {
  chunkId: number;
  docId: number;
  filename: string;
  headingPath: string;
  text: string;
  ordinal: number;
  score: number;
}

export interface EmbeddingProvider {
  /** Stamped into the index so a later provider swap fails loudly, not silently. */
  model: string;
  /**
   * Batched to keep round-trips down; results are returned in input order.
   * `kind` matters — asymmetric models embed a question differently from the
   * passage that answers it, and passing the wrong one quietly costs recall.
   */
  embed(texts: string[], kind: "document" | "query", signal?: AbortSignal): Promise<Float32Array[]>;
}

/**
 * Writes the one-line manifest entry for a document. Implementations exist for
 * the Anthropic SDK and for any OpenAI-compatible endpoint (OpenRouter,
 * DeepSeek, Gemini's compatibility layer, Groq), so the provider is a config
 * choice rather than a code path.
 */
export interface SummarizerProvider {
  /** Provider label, for error messages and logs. */
  name: string;
  model: string;
  summarize(filename: string, text: string, signal?: AbortSignal): Promise<DocumentSummary>;
}

export interface NotesProviders {
  embeddings: { provider: string; model: string; configured: boolean };
  summaries: { provider: string; model: string; configured: boolean };
}
