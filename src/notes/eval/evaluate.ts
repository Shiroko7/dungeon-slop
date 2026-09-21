import corpus from "./corpus.json";
import { openNotesDb } from "../db.ts";
import { createCampaign } from "../../campaign/campaigns.ts";
import { ingestDocument } from "../ingest.ts";
import { lexicalQuery, RETRIEVAL_PARAMETERS, searchNotes } from "../retrieval.ts";
import type { EmbeddingProvider } from "../types.ts";
import type { SearchMode } from "../retrieval-types.ts";

const synonyms = [
  ["archive", "password", "phrase", "repository", "librarian", "scrolls"],
  ["healer", "cures", "cure", "fever", "disease", "sickness", "treatment", "clinic"],
  ["ferry", "ferryman", "rowing", "boat", "fare", "ticket", "passenger"],
  ["ghost", "haunts", "haunting", "specter", "unfinished"],
  ["inn", "guest", "bed", "lodging", "overnight", "accommodation"],
  ["well", "poisoned", "drinking", "water", "contaminated", "potable", "supply"],
];
function words(text: string): string[] { return lexicalQuery(text).match(/[\p{L}\p{N}_]+/gu)?.filter((word) => word !== "OR") ?? []; }
// Closed vocabulary avoids hash collisions and needs no network. Judgments and
// document IDs are never used in features. This is not a production embedder.
const vocabulary = [...new Set([...corpus.documents.map((doc) => doc.text), ...corpus.queries.map((query) => query.query)]
  .flatMap(words))].sort();
const positions = new Map(vocabulary.map((word, index) => [word, index]));
export const syntheticEmbedder: EmbeddingProvider = {
  model: "m21-synthetic-v1",
  embed: async (texts) => texts.map((text) => {
    const tokens = new Set(words(text));
    const vector = new Float32Array(vocabulary.length + synonyms.length);
    for (const token of tokens) {
      const index = positions.get(token);
      if (index !== undefined) vector[index] = 1;
    }
    synonyms.forEach((group, index) => {
      if (group.some((word) => tokens.has(word))) vector[vocabulary.length + index] = 3;
    });
    return vector;
  }),
};

export async function evaluateRetrieval() {
  const db = openNotesDb(":memory:");
  try {
    createCampaign(db, { name: "Vess evaluation" });
    createCampaign(db, { name: "Separate Vess" });
    const keys = new Map<number, string>();
    for (const doc of corpus.documents) {
      const indexed = await ingestDocument(db, syntheticEmbedder,
        { name: "fixture", model: "fixture", summarize: async () => ({ summary: "Synthetic fixture", entities: [] }) },
        { campaignId: doc.campaign, filename: doc.filename, content: doc.text }, { deferSummary: true });
      keys.set(indexed.document.id, doc.key);
    }
    const modes = ["lexical", "semantic", "hybrid"] as const;
    const report = {
      dataset: corpus.version,
      corpusSha256: new Bun.CryptoHasher("sha256").update(JSON.stringify(corpus)).digest("hex"),
      documents: corpus.documents.length,
      queries: corpus.queries.length,
      targetHitAt5: corpus.targetHitAt5,
      parameters: { limit: 5, tokenBudget: 3000, neighbors: 0, ...RETRIEVAL_PARAMETERS, embeddingModel: syntheticEmbedder.model },
      modes: {} as Record<SearchMode, { answerableQueries: number; hitAt5: number; allRelevantAt5: number; multiSourceAllAt5: number; missingEmpty: number; missingQueries: number; leaks: number; failures: string[] }>,
    };
    for (const mode of modes) {
      let answerable = 0, hits = 0, allHits = 0, missingEmpty = 0, missingQueries = 0, leaks = 0;
      let multiQueries = 0, multiHits = 0;
      const failures: string[] = [];
      for (const query of corpus.queries) {
        const result = await searchNotes(db, query.campaign,
          { query: query.query, mode, limit: 5, tokenBudget: 3000, neighbors: 0 }, () => syntheticEmbedder);
        const found = new Set(result.results.map((hit) => keys.get(hit.citation.documentId)));
        leaks += result.results.filter((hit) => hit.citation.campaignId !== query.campaign ||
          corpus.documents.find((doc) => doc.key === keys.get(hit.citation.documentId))?.campaign !== query.campaign).length;
        if (!query.expected.length) { missingQueries++; if (!result.results.length) missingEmpty++; continue; }
        answerable++;
        if (query.expected.some((key) => found.has(key))) hits++;
        else failures.push(query.id);
        if (query.expected.every((key) => found.has(key))) allHits++;
        if (query.expected.length > 1) {
          multiQueries++;
          if (query.expected.every((key) => found.has(key))) multiHits++;
        }
      }
      report.modes[mode] = { answerableQueries: answerable, hitAt5: hits / answerable, allRelevantAt5: allHits / answerable,
        multiSourceAllAt5: multiQueries ? multiHits / multiQueries : 0, missingEmpty, missingQueries, leaks, failures };
    }
    return report;
  } finally { db.close(); }
}

if (import.meta.main) {
  const report = await evaluateRetrieval();
  console.log(JSON.stringify(report, null, 2));
  if (report.modes.hybrid.hitAt5 < report.targetHitAt5 || Object.values(report.modes).some((mode) => mode.leaks > 0)) process.exitCode = 1;
}
