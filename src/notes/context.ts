import type { Database } from "bun:sqlite";
import { appDb, closeAppDb } from "../db/context.ts";
import { createVoyageProvider } from "./embeddings.ts";
import { embedderFromEnv, summarizerFromEnv, PRESETS } from "./providers.ts";
import type { EmbeddingProvider, SummarizerProvider, NotesProviders } from "./types.ts";

/**
 * Process-wide handles for the notes subsystem. Opened lazily so importing a
 * route never demands API keys at module-load time — a missing key should fail
 * the one request that needs it, not the whole server.
 */
let embedder: EmbeddingProvider | null = null;
let summarizer: SummarizerProvider | null = null;

/**
 * The notes tables live in the application database alongside campaigns and
 * dungeons, so this is the same connection the rest of the server uses.
 */
export function notesDb(): Database {
  return appDb();
}

/**
 * `NOTES_EMBEDDING_PROVIDER=voyage` takes the dedicated Voyage client; anything
 * else resolves through the OpenAI-compatible layer. Voyage is separate because
 * its `input_type` distinction between documents and queries has no equivalent
 * in the OpenAI wire format, and collapsing it would cost recall silently.
 */
export function notesEmbedder(): EmbeddingProvider {
  if (embedder === null) {
    embedder =
      process.env.NOTES_EMBEDDING_PROVIDER === "voyage"
        ? createVoyageProvider()
        : embedderFromEnv();
  }
  return embedder;
}

export function notesSummarizer(): SummarizerProvider {
  summarizer ??= summarizerFromEnv();
  return summarizer;
}

/** Public configuration only. Never return keys or instantiate a client here. */
export function notesProviderMetadata(): NotesProviders {
  const summary = process.env.NOTES_PROVIDER ?? "gemini";
  const embedding = process.env.NOTES_EMBEDDING_PROVIDER ?? summary;
  const summaryPreset = PRESETS[summary];
  const embeddingPreset = PRESETS[embedding];
  return {
    embeddings: {
      provider: embedding,
      model: embedding === "voyage" ? process.env.VOYAGE_MODEL ?? "voyage-4-lite"
        : process.env.NOTES_EMBEDDING_MODEL ?? embeddingPreset?.defaultEmbeddingModel ?? "unavailable",
      configured: embedding === "voyage" ? Boolean(process.env.VOYAGE_API_KEY)
        : Boolean(embeddingPreset?.defaultEmbeddingModel && process.env[embeddingPreset.envKey]),
    },
    summaries: {
      provider: summary,
      model: process.env.NOTES_SUMMARY_MODEL ?? summaryPreset?.defaultModel ?? "unavailable",
      configured: Boolean(summaryPreset && process.env[summaryPreset.envKey]),
    },
  };
}

// Source is persisted before client resolution so missing credentials are
// recoverable per-file failures, and summary configuration cannot block indexing.
export function lazyNotesProviders(): { embedder: EmbeddingProvider; summarizer: SummarizerProvider } {
  const metadata = notesProviderMetadata();
  return {
    embedder: { model: metadata.embeddings.model, embed: (...args) => notesEmbedder().embed(...args) },
    summarizer: { name: metadata.summaries.provider, model: metadata.summaries.model,
      summarize: (...args) => notesSummarizer().summarize(...args) },
  };
}

/** Test seam: drop cached handles so the next call re-resolves them. */
export function resetNotesContext(): void {
  closeAppDb();
  embedder = null;
  summarizer = null;
}
