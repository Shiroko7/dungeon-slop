/** Browser-safe contracts shared by the reader, diagnostic API and future agents. */
export type SearchMode = "lexical" | "semantic" | "hybrid";
export interface NoteSearchInput {
  query: string;
  mode?: SearchMode;
  /** Omitted: entire campaign. Empty: no sources. */
  documentIds?: number[];
  limit?: number;
  tokenBudget?: number;
  neighbors?: 0 | 1;
}
export interface NoteCitation {
  campaignId: number;
  documentId: number;
  revision: number;
  chunkId: number;
  filename: string;
  headingPath: string;
  /** UTF-16 character offsets in LF-normalized source; end is exclusive. */
  startOffset: number;
  endOffset: number;
}
export interface NotePassage {
  citation: NoteCitation;
  text: string;
  tokens: number;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  truncated: boolean;
}
export interface NoteSearchResult {
  query: string;
  mode: SearchMode;
  usedMode: SearchMode;
  status: "ready" | "empty-query" | "empty-index" | "no-sources" | "unavailable" | "no-matches";
  results: NotePassage[];
  tokenBudget: number;
  tokensUsed: number;
  warnings: string[];
  diagnostics: { lexicalCandidates: number; semanticCandidates: number; indexedChunks: number; embeddingModel: string | null };
}
export interface ReaderChunk {
  id: number;
  ordinal: number;
  headingPath: string;
  startOffset: number;
  endOffset: number;
  text: string;
}
export interface NoteReader {
  campaignId: number;
  documentId: number;
  filename: string;
  revision: number;
  activeRevision: number;
  contentHash: string;
  indexStatus: string;
  /** Exact stored text, or null for legacy data. */
  source: string | null;
  chunks: ReaderChunk[];
  notice: string | null;
}
