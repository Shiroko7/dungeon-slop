import type { Database } from "bun:sqlite";
import { listDocuments } from "../notes/db.ts";
import { readNote, NoteAccessError } from "../notes/reader.ts";
import { searchNotes } from "../notes/retrieval.ts";
import type { NotePassage, NoteSearchResult } from "../notes/retrieval-types.ts";
import type { EmbeddingProvider } from "../notes/types.ts";
import type { ToolCallRecord } from "../campaign/types.ts";

export const TOOL_NAMES = ["list_documents", "search_notes", "read_document"] as const;
export type LoremasterTool = (typeof TOOL_NAMES)[number];

export interface ToolExecution {
  record: ToolCallRecord;
  text: string;
  passages: NotePassage[];
}

const MAX_RESULT_CHARS = 12_000;

function objectArgs(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = MAX_RESULT_CHARS): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > max ? `${raw.slice(0, max)}\n[…tool output shortened…]` : raw;
}

function selectedIds(args: Record<string, unknown>): number[] | undefined {
  if (args.documentIds === undefined) return undefined;
  if (!Array.isArray(args.documentIds) || args.documentIds.length > 50 ||
      args.documentIds.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)) {
    throw new NoteAccessError("documentIds must be a list of up to 50 positive note IDs", 400, "invalid_tool_args");
  }
  return [...new Set(args.documentIds as number[])];
}

function searchArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.query !== "string" || args.query.trim() === "") throw new NoteAccessError("search_notes needs a non-empty query", 400, "invalid_tool_args");
  const mode = args.mode === undefined ? "hybrid" : args.mode;
  if (mode !== "lexical" && mode !== "semantic" && mode !== "hybrid") throw new NoteAccessError("search_notes mode is invalid", 400, "invalid_tool_args");
  const limit = args.limit === undefined ? 6 : Number(args.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new NoteAccessError("search_notes limit must be between 1 and 8", 400, "invalid_tool_args");
  const tokenBudget = args.tokenBudget === undefined ? 3500 : Number(args.tokenBudget);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 128 || tokenBudget > 5000) throw new NoteAccessError("search_notes tokenBudget must be between 128 and 5,000", 400, "invalid_tool_args");
  return { query: args.query, mode, limit, tokenBudget, neighbors: 0, documentIds: selectedIds(args) };
}

function summarizeSearch(result: NoteSearchResult, passages: NotePassage[]): string {
  const body = result.results.map((passage, index) => {
    const source = `S${index + 1}`;
    passages.push(passage);
    return `[${source}] ${passage.citation.filename} / revision ${passage.citation.revision} / ${passage.citation.headingPath || "Document"}\n${passage.text}`;
  }).join("\n\n");
  return `status=${result.status}; mode=${result.usedMode}; warnings=${result.warnings.join(" | ") || "none"}\n${body || "No passages matched."}`;
}

/** Read-only and campaign-bound. Tool output is evidence, never instructions. */
export async function executeTool(
  db: Database,
  campaignId: number,
  name: string,
  rawArgs: unknown,
  getEmbedder: () => EmbeddingProvider,
  signal: AbortSignal,
): Promise<ToolExecution> {
  signal.throwIfAborted();
  const args = objectArgs(rawArgs);
  if (!TOOL_NAMES.includes(name as LoremasterTool)) throw new NoteAccessError(`Unknown Loremaster tool: ${name}`, 400, "unknown_tool");
  const tool = name as LoremasterTool;
  const passages: NotePassage[] = [];
  let output: string;
  if (tool === "list_documents") {
    const documents = listDocuments(db, campaignId).map((doc) => ({ id: doc.id, filename: doc.filename,
      revision: doc.activeRevision, indexStatus: doc.activeIndexStatus, summaryStatus: doc.summaryStatus,
      tokens: doc.tokens, chunks: doc.chunkCount, sourceAvailable: doc.sourceAvailable }));
    output = text({ campaignId, documents });
  } else if (tool === "search_notes") {
    const result = await searchNotes(db, campaignId, searchArgs(args), getEmbedder, signal);
    output = summarizeSearch(result, passages);
  } else {
    const documentId = Number(args.documentId);
    const revision = Number(args.revision);
    const chunkId = args.chunkId === undefined ? undefined : Number(args.chunkId);
    if (!Number.isSafeInteger(documentId) || (documentId as number) <= 0 ||
        !Number.isSafeInteger(revision) || (revision as number) <= 0 ||
        (chunkId !== undefined && (!Number.isSafeInteger(chunkId) || (chunkId as number) <= 0))) {
      throw new NoteAccessError("read_document needs positive documentId/revision and optional chunkId", 400, "invalid_tool_args");
    }
    const note = readNote(db, campaignId, documentId, revision, chunkId as number | undefined);
    const chosen = chunkId === undefined ? note.chunks.slice(0, 4) : note.chunks.filter((chunk) => chunk.id === chunkId);
    output = text({ filename: note.filename, revision: note.revision, sourceAvailable: note.source !== null,
      notice: note.notice, passages: chosen.map((chunk) => ({ id: chunk.id, headingPath: chunk.headingPath,
        startOffset: chunk.startOffset, endOffset: chunk.endOffset, text: chunk.text })) });
    for (const chunk of chosen) {
      passages.push({ citation: { campaignId, documentId, revision, chunkId: chunk.id, filename: note.filename,
        headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
        text: chunk.text, tokens: Math.ceil(chunk.text.length / 4), score: 1, lexicalRank: null, semanticRank: null, truncated: false });
    }
  }
  return { record: { name: tool, args, status: "completed", result: text(output, 800) }, text: output, passages };
}
