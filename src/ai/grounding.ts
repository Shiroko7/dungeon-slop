import type { Database } from "bun:sqlite";
import { z } from "zod";
import { searchNotes } from "../notes/retrieval.ts";
import type { EmbeddingProvider } from "../notes/types.ts";
import type { NotePassage } from "../notes/retrieval-types.ts";
import type { GroundingProvenance, GroundingSelection } from "./grounding-types.ts";

export const GroundingSelectionSchema = z.object({
  documentIds: z.array(z.number().int().positive()).max(50).optional(),
  query: z.string().max(1000).optional(),
}).strict();

export interface GroundingContext {
  provenance: GroundingProvenance;
  passages: NotePassage[];
  promptText: string;
}

function emptyContext(query: string, documentIds: number[] | null, status: GroundingProvenance["status"]): GroundingContext {
  return {
    provenance: { query, documentIds, citations: [], warnings: [], status, retrievedAt: Date.now() },
    passages: [],
    promptText: "(No campaign note passages were available.)",
  };
}

/**
 * Retrieve a small, explicit evidence packet for a generation request. The
 * caller supplies the campaign and the request is always filtered to it by
 * searchNotes; note text is wrapped as evidence so it cannot become an
 * instruction to the generation model.
 */
export async function retrieveGrounding(
  db: Database,
  campaignId: number,
  selection: GroundingSelection | undefined,
  fallbackQuery: string,
  getEmbedder: () => EmbeddingProvider,
  signal: AbortSignal,
): Promise<GroundingContext> {
  const parsed = GroundingSelectionSchema.safeParse(selection ?? {});
  if (!parsed.success) throw new Error("Invalid note source selection");
  const query = (parsed.data.query ?? fallbackQuery).trim().slice(0, 1000);
  const documentIds = parsed.data.documentIds ?? null;
  if (query === "") return emptyContext(query, documentIds, "empty-query");

  const result = await searchNotes(db, campaignId, {
    query,
    mode: "hybrid",
    documentIds: parsed.data.documentIds,
    limit: 8,
    tokenBudget: 3500,
    neighbors: 1,
  }, getEmbedder, signal);
  const passages = result.results.slice(0, 12);
  const citations = passages.map((passage) => ({
    campaignId: passage.citation.campaignId,
    documentId: passage.citation.documentId,
    revision: passage.citation.revision,
    chunkId: passage.citation.chunkId,
    filename: passage.citation.filename,
    headingPath: passage.citation.headingPath,
    snippet: passage.text.slice(0, 1200),
    startOffset: passage.citation.startOffset,
    endOffset: passage.citation.endOffset,
  }));
  const promptText = passages.length === 0
    ? "(No campaign note passages matched the selected sources.)"
    : passages.map((passage, index) =>
      `[S${index + 1}] ${passage.citation.filename} — revision ${passage.citation.revision} — ${passage.citation.headingPath || "Document"}\n${passage.text}`,
    ).join("\n\n");
  return {
    provenance: {
      query,
      documentIds,
      citations,
      warnings: result.warnings.slice(0, 12),
      status: result.status,
      retrievedAt: Date.now(),
    },
    passages,
    promptText,
  };
}
