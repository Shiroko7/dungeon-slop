import type { Database } from "bun:sqlite";
import { appDb, closeAppDb } from "../db/context.ts";
import { createVoyageProvider } from "./embeddings.ts";
import { embedderFromEnv, summarizerFromEnv } from "./providers.ts";
import type { EmbeddingProvider, SummarizerProvider } from "./types.ts";

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

/** Test seam: drop cached handles so the next call re-resolves them. */
export function resetNotesContext(): void {
  closeAppDb();
  embedder = null;
  summarizer = null;
}
