import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { campaignExists } from "../campaign/campaigns.ts";
import { decodeVector, getMeta } from "./db.ts";
import { dot, normalize } from "./embeddings.ts";
import { estimateTokens } from "./chunker.ts";
import { NoteAccessError } from "./reader.ts";
import { WorkLimit } from "./work-limit.ts";
import type { EmbeddingProvider } from "./types.ts";
import type { NoteCitation, NotePassage, NoteSearchResult, SearchMode } from "./retrieval-types.ts";

export const SearchInputSchema = z.object({
  query: z.string().max(1000),
  mode: z.enum(["lexical", "semantic", "hybrid"]).default("lexical"),
  documentIds: z.array(z.number().int().positive().safe()).max(200).optional(),
  limit: z.number().int().min(1).max(20).default(5),
  tokenBudget: z.number().int().min(128).max(8000).default(3000),
  neighbors: z.union([z.literal(0), z.literal(1)]).default(1),
}).strict();

export const RETRIEVAL_PARAMETERS = { candidateLimit: 60, rrfK: 60, maximumVectorChunks: 50_000 } as const;
const { candidateLimit: CANDIDATES, rrfK: RRF_K, maximumVectorChunks: MAX_VECTOR_SCAN } = RETRIEVAL_PARAMETERS;
const queryWork = new WorkLimit(2);
const STOP_WORDS = new Set("a an and are as at be by can did do does for from how i in is it me of on or our that the their there these this to was we were what when where which who why with would you".split(" "));

/** Literal OR terms, never user-controlled FTS syntax or SQL. */
export function lexicalQuery(query: string): string {
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((term) => !STOP_WORDS.has(term)))].slice(0, 32);
  return terms.map((term) => `"${term}"`).join(" OR ");
}

interface ChunkRow {
  id: number; doc_id: number; source_revision: number; filename: string;
  ordinal: number; heading_path: string; text: string; start_offset: number; end_offset: number;
}
interface Ranked { id: number; score: number; lexicalRank: number | null; semanticRank: number | null }
const CHUNK_COLUMNS = "c.id, c.doc_id, c.source_revision, d.filename, c.ordinal, c.heading_path, c.text, c.start_offset, c.end_offset";

/** Pure rank fusion: raw BM25 and cosine scores are deliberately not added. */
export function fuseRanks(lexical: number[], semantic: number[], mode: SearchMode): Ranked[] {
  const ranks = new Map<number, Ranked>();
  const add = (ids: number[], kind: "lexicalRank" | "semanticRank") => {
    [...new Set(ids)].forEach((id, index) => {
      const item = ranks.get(id) ?? { id, score: 0, lexicalRank: null, semanticRank: null };
      item[kind] = index + 1;
      item.score += 1 / (RRF_K + index + 1);
      ranks.set(id, item);
    });
  };
  if (mode !== "semantic") add(lexical, "lexicalRank");
  if (mode !== "lexical") add(semantic, "semanticRank");
  return [...ranks.values()].sort((a, b) => b.score - a.score || a.id - b.id);
}

/** Read-only retrieval; provider resolution is lazy so keyword search needs no key. */
export async function searchNotes(db: Database, campaignId: number, raw: unknown,
  getEmbedder?: () => EmbeddingProvider, parentSignal?: AbortSignal): Promise<NoteSearchResult> {
  const parsed = SearchInputSchema.safeParse(raw);
  if (!parsed.success) throw new NoteAccessError("Invalid search: query up to 1,000 characters, 1–20 results, 128–8,000 estimated tokens, and at most 200 source IDs.", 400, "invalid_search");
  const input = parsed.data;
  if (!campaignExists(db, campaignId)) throw new NoteAccessError("Campaign no longer exists.", 404, "owner_missing");
  const ids = input.documentIds === undefined ? undefined : [...new Set(input.documentIds)];
  if (ids?.length) {
    const owned = db.query(`SELECT COUNT(*) AS n FROM documents WHERE campaign_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .get(campaignId, ...ids) as { n: number };
    if (owned.n !== ids.length) throw new NoteAccessError("A selected source is not available in this campaign.", 404, "source_missing");
  }
  const result: NoteSearchResult = { query: input.query.trim(), mode: input.mode, usedMode: input.mode,
    status: "ready", results: [], tokenBudget: input.tokenBudget, tokensUsed: 0, warnings: [],
    diagnostics: { lexicalCandidates: 0, semanticCandidates: 0, indexedChunks: 0, embeddingModel: null } };
  if (!result.query || !lexicalQuery(result.query)) return { ...result, status: "empty-query" };
  if (ids?.length === 0) return { ...result, status: "no-sources" };
  const scope = `d.campaign_id = ? AND c.source_revision = d.active_revision${ids ? ` AND d.id IN (${ids.map(() => "?").join(",")})` : ""}`;
  const bindings: SQLQueryBindings[] = [campaignId, ...(ids ?? [])];
  const count = () => (db.query(`SELECT COUNT(*) AS n FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE ${scope}`).get(...bindings) as { n: number }).n;
  result.diagnostics.indexedChunks = count();
  if (!result.diagnostics.indexedChunks) return { ...result, status: "empty-index" };
  const signal = AbortSignal.any([parentSignal ?? new AbortController().signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  let queryVector: Float32Array | null = null;
  const stamp = getMeta(db, "embedding_model");
  if (input.mode !== "lexical") {
    try {
      if (result.diagnostics.indexedChunks > MAX_VECTOR_SCAN) throw new Error("Semantic scan limit is 50,000 chunks. Select fewer sources.");
      if (!stamp) throw new Error("The index has no embedding model. Reindex selected notes or use keyword search.");
      const dimensions = Number(stamp.slice(stamp.lastIndexOf(":") + 1));
      const model = stamp.slice(0, stamp.lastIndexOf(":"));
      result.diagnostics.embeddingModel = model;
      if (!getEmbedder) throw new Error("Query embedding is not configured. Use keyword search.");
      const embedder = getEmbedder();
      if (embedder.model !== model) throw new Error(`Index uses ${model}; configured query model is ${embedder.model}. Switch back or use keyword search.`);
      const vectors = await queryWork.run(signal, () => embedder.embed([result.query], "query", signal));
      signal.throwIfAborted();
      const vector = vectors[0];
      if (vectors.length !== 1 || !vector || vector.length !== dimensions ||
          vector.some((n) => !Number.isFinite(n)) || !vector.some((n) => n !== 0)) {
        throw new Error("Query embedding has invalid count, dimensions, or values. Use keyword search.");
      }
      queryVector = normalize(vector);
    } catch (error) {
      signal.throwIfAborted();
      result.warnings.push(error instanceof Error ? error.message : "Query embedding failed.");
      if (input.mode === "semantic") return { ...result, status: "unavailable" };
      result.usedMode = "lexical";
      result.warnings.push("Showing keyword results only; semantic search was unavailable.");
    }
  }

  // No await inside this read snapshot. A replacement during query embedding is
  // resolved consistently against its new active index, never cached old rows.
  return db.transaction(() => {
    signal.throwIfAborted();
    if (queryVector && getMeta(db, "embedding_model") !== stamp) throw new NoteAccessError("The index model changed during search. Please retry.", 409, "index_changed");
    result.diagnostics.indexedChunks = count();
    if (!result.diagnostics.indexedChunks) return { ...result, status: "empty-index" as const };
    const lexical = result.usedMode === "semantic" ? [] : (db.query(`SELECT c.id FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.doc_id
      WHERE chunks_fts MATCH ? AND ${scope} ORDER BY bm25(chunks_fts), c.id LIMIT ?`)
      .all(lexicalQuery(result.query), ...bindings, CANDIDATES) as { id: number }[]).map((row) => row.id);
    const semantic: Array<{ id: number; score: number }> = [];
    let invalidVectors = 0;
    if (queryVector) {
      if (result.diagnostics.indexedChunks > MAX_VECTOR_SCAN) throw new NoteAccessError("The index grew beyond the semantic scan limit. Select fewer sources.", 409, "index_changed");
      const rows = db.query(`SELECT c.id, e.vec FROM chunks c JOIN documents d ON d.id = c.doc_id
        JOIN embeddings e ON e.chunk_id = c.id WHERE ${scope} ORDER BY c.id`).iterate(...bindings);
      for (const value of rows) {
        const row = value as { id: number; vec: Uint8Array };
        if (row.vec.byteLength !== queryVector.byteLength) { invalidVectors++; continue; }
        const vector = decodeVector(row.vec);
        if (vector.some((n) => !Number.isFinite(n)) || !vector.some((n) => n !== 0)) { invalidVectors++; continue; }
        const score = dot(queryVector, normalize(vector));
        // Nonpositive similarity is not a useful semantic candidate. Positive
        // similarity is still ranking, not calibrated evidence of an answer.
        if (score <= 0) continue;
        semantic.push({ id: row.id, score });
        semantic.sort((a, b) => b.score - a.score || a.id - b.id);
        if (semantic.length > CANDIDATES) semantic.pop();
      }
    }
    if (invalidVectors) result.warnings.push(`${invalidVectors} incompatible stored vectors were skipped; reindex affected notes.`);
    result.diagnostics.lexicalCandidates = lexical.length;
    result.diagnostics.semanticCandidates = semantic.length;
    const ranks = fuseRanks(lexical, semantic.map((item) => item.id), result.usedMode);
    const covered = new Map<number, Array<[number, number]>>();
    for (const rank of ranks) {
      if (result.results.length >= input.limit || result.tokensUsed >= input.tokenBudget) break;
      const row = db.query(`SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id = ? AND ${scope}`)
        .get(rank.id, ...bindings) as ChunkRow | null;
      if (!row) continue;
      const ranges = covered.get(row.doc_id) ?? [];
      if (ranges.some(([start, end]) => row.start_offset < end && row.end_offset > start)) continue;
      // Spend the budget on the matching chunk before its neighbors. Expand only
      // when the whole expanded span fits; never truncate away the matching chunk.
      let start = row.start_offset;
      let end = row.end_offset;
      let text = row.text;
      const available = (input.tokenBudget - result.tokensUsed) * 4;
      if (input.neighbors && text.length <= available) {
        const bounds = db.query(`SELECT MIN(start_offset) AS start, MAX(end_offset) AS end FROM chunks
          WHERE doc_id = ? AND source_revision = ? AND ordinal BETWEEN ? AND ?`)
          .get(row.doc_id, row.source_revision, row.ordinal - 1, row.ordinal + 1) as { start: number; end: number };
        if (bounds.end - bounds.start <= available && !ranges.some(([a, b]) => bounds.start < b && bounds.end > a)) {
          // JS slice uses UTF-16 offsets; SQLite substr uses Unicode characters.
          const source = db.query("SELECT source_text FROM note_revisions WHERE doc_id = ? AND revision = ?")
            .get(row.doc_id, row.source_revision) as { source_text: string | null } | null;
          if (source?.source_text !== null && source?.source_text !== undefined) {
            start = bounds.start; end = bounds.end;
            text = source.source_text.replace(/\r\n/g, "\n").slice(start, end);
          }
        }
      }
      const truncated = text.length > available;
      if (truncated) {
        const terms = lexicalQuery(result.query).match(/"([^"]+)"/g)?.map((term) => term.slice(1, -1)) ?? [];
        const match = terms.length ? new RegExp(terms.join("|"), "iu").exec(text) : null;
        let offset = Math.min(Math.max(0, (match?.index ?? 0) - 80), text.length - available);
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]!)) offset++;
        text = text.slice(offset, offset + available);
        start += offset;
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        end = start + text.length;
      }
      if (!text) continue;
      const citation: NoteCitation = { campaignId, documentId: row.doc_id, revision: row.source_revision,
        chunkId: row.id, filename: row.filename, headingPath: row.heading_path, startOffset: start, endOffset: end };
      const passage: NotePassage = { citation, text, tokens: estimateTokens(text), score: rank.score,
        lexicalRank: rank.lexicalRank, semanticRank: rank.semanticRank, truncated };
      result.results.push(passage);
      result.tokensUsed += passage.tokens;
      covered.set(row.doc_id, [...ranges, [start, end]]);
    }
    if (!result.results.length) result.status = "no-matches";
    return result;
  })();
}
