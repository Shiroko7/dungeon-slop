/** Browser-safe provenance contracts for note-grounded generation. */
export interface GroundingCitation {
  campaignId: number;
  documentId: number;
  revision: number;
  chunkId: number;
  filename: string;
  headingPath: string;
  snippet: string;
  startOffset: number;
  endOffset: number;
}

export interface GroundingProvenance {
  query: string;
  documentIds: number[] | null;
  citations: GroundingCitation[];
  warnings: string[];
  status: "ready" | "empty-query" | "empty-index" | "no-sources" | "unavailable" | "no-matches";
  retrievedAt: number;
}

export interface GroundingSelection {
  /** Omit to search every indexed note in the campaign; [] means no notes. */
  documentIds?: number[];
  query?: string;
}
