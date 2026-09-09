import {
  SUMMARY_JSON_SCHEMA,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryPrompt,
  parseSummary,
} from "./summary-spec.ts";
import type { DocumentSummary, EmbeddingProvider, SummarizerProvider } from "./types.ts";

/**
 * How a provider is told to emit JSON.
 *
 * `json_schema` constrains decoding to the schema and is the strongest option
 * where it exists. `json_object` only promises valid JSON, not the right shape.
 * `prompt` promises nothing and leans on `parseSummary` to recover the payload.
 * Everything validates with zod afterwards regardless, so a provider that
 * silently ignores the hint degrades in quality rather than in correctness.
 */
export type StructuredMode = "json_schema" | "json_object" | "prompt";

export interface OpenAICompatConfig {
  /** Must end in a slash — most compatibility layers 404 without it. */
  baseUrl: string;
  apiKey: string;
  model: string;
  structuredMode?: StructuredMode;
  /** Sent by OpenRouter for leaderboard attribution; harmless elsewhere. */
  appName?: string;
}

interface Preset {
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  defaultEmbeddingModel?: string;
  structuredMode: StructuredMode;
}

/**
 * Every entry speaks the OpenAI wire format, so switching providers is two
 * environment variables rather than a new client. Gemini is the default because
 * its free tier serves both chat and embeddings from one key — enough to
 * develop the whole pipeline at zero cost.
 */
export const PRESETS: Record<string, Preset> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-flash-latest",
    defaultEmbeddingModel: "gemini-embedding-001",
    structuredMode: "json_schema",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1/",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "deepseek/deepseek-v4-flash",
    structuredMode: "json_object",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1/",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    structuredMode: "json_object",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1/",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5.6-luna",
    defaultEmbeddingModel: "text-embedding-3-small",
    structuredMode: "json_schema",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1/",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    structuredMode: "json_object",
  },
};

const MAX_ATTEMPTS = 4;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(config: OpenAICompatConfig): Record<string, string> {
  const base: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };
  if (config.appName !== undefined) {
    base["x-title"] = config.appName;
  }
  return base;
}

async function post(config: OpenAICompatConfig, path: string, body: unknown): Promise<unknown> {
  let lastError = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(new URL(path, config.baseUrl), {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (response.ok) return response.json();

    lastError = `${response.status} ${(await response.text()).slice(0, 400)}`;
    if (!isRetryable(response.status)) break;
    await backoff(attempt);
  }

  throw new Error(`${config.model} request to ${path} failed: ${lastError}`);
}

// ─── chat ─────────────────────────────────────────────────────────────────────

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

function responseFormat(mode: StructuredMode): Record<string, unknown> | undefined {
  if (mode === "json_schema") {
    return {
      response_format: {
        type: "json_schema",
        json_schema: { name: "document_summary", strict: true, schema: SUMMARY_JSON_SCHEMA },
      },
    };
  }
  if (mode === "json_object") {
    return { response_format: { type: "json_object" } };
  }
  return undefined;
}

export function createOpenAICompatSummarizer(config: OpenAICompatConfig): SummarizerProvider {
  const mode = config.structuredMode ?? "json_object";

  return {
    name: `openai-compat:${new URL(config.baseUrl).host}`,
    model: config.model,

    async summarize(filename: string, text: string): Promise<DocumentSummary> {
      const data = (await post(config, "chat/completions", {
        model: config.model,
        max_tokens: SUMMARY_MAX_TOKENS,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: buildSummaryPrompt(filename, text) },
        ],
        ...responseFormat(mode),
      })) as ChatResponse;

      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error(`${config.model} returned no content for "${filename}"`);
      }
      return parseSummary(content);
    },
  };
}

// ─── embeddings ───────────────────────────────────────────────────────────────

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

/** Conservative batching: compatibility layers vary in what they accept. */
const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_CHARS = 200_000;

function batch(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const text of texts) {
    const overflow = current.length >= MAX_BATCH_ITEMS || chars + text.length > MAX_BATCH_CHARS;
    if (overflow && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export function createOpenAICompatEmbedder(config: OpenAICompatConfig): EmbeddingProvider {
  return {
    model: config.model,

    async embed(texts) {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];

      for (const group of batch(texts)) {
        const data = (await post(config, "embeddings", {
          model: config.model,
          input: group,
        })) as EmbeddingResponse;

        const rows = data.data ?? [];
        if (rows.length !== group.length) {
          throw new Error(
            `${config.model} returned ${rows.length} embeddings for ${group.length} inputs`,
          );
        }

        // Index order is documented but not guaranteed by the wire format; sort
        // rather than trust it, because a silent shuffle maps every chunk to the
        // wrong vector and nothing downstream can detect it.
        const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const row of sorted) {
          if (!Array.isArray(row.embedding)) {
            throw new Error(`${config.model} returned a row with no embedding`);
          }
          out.push(Float32Array.from(row.embedding));
        }
      }

      return out;
    },
  };
}

// ─── env resolution ───────────────────────────────────────────────────────────

export function resolvePreset(name: string): Preset {
  const preset = PRESETS[name];
  if (preset === undefined) {
    throw new Error(
      `Unknown provider "${name}". Expected one of: ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  return preset;
}

function requireKey(preset: Preset, providerName: string): string {
  const key = process.env[preset.envKey];
  if (key === undefined || key === "") {
    throw new Error(
      `${preset.envKey} is not set — required for the "${providerName}" notes provider.`,
    );
  }
  return key;
}

/** Chat provider for the ingest summary pass, from `NOTES_PROVIDER`. */
export function summarizerFromEnv(): SummarizerProvider {
  const name = process.env.NOTES_PROVIDER ?? "gemini";
  const preset = resolvePreset(name);

  return createOpenAICompatSummarizer({
    baseUrl: preset.baseUrl,
    apiKey: requireKey(preset, name),
    model: process.env.NOTES_SUMMARY_MODEL ?? preset.defaultModel,
    structuredMode: preset.structuredMode,
    appName: "dungeon-slop",
  });
}

/**
 * Embedding provider, from `NOTES_EMBEDDING_PROVIDER`. Falls back to the chat
 * provider only when that provider actually serves embeddings — OpenRouter,
 * DeepSeek and Groq do not, and a silent fallback there would fail deep inside
 * an ingest run rather than at startup.
 */
export function embedderFromEnv(): EmbeddingProvider {
  const explicit = process.env.NOTES_EMBEDDING_PROVIDER;
  const name = explicit ?? process.env.NOTES_PROVIDER ?? "gemini";
  const preset = resolvePreset(name);

  if (preset.defaultEmbeddingModel === undefined) {
    throw new Error(
      `Provider "${name}" does not serve embeddings. Set NOTES_EMBEDDING_PROVIDER to one ` +
        `of: ${Object.entries(PRESETS)
          .filter(([, p]) => p.defaultEmbeddingModel !== undefined)
          .map(([k]) => k)
          .join(", ")} — or use voyage (see embeddings.ts).`,
    );
  }

  return createOpenAICompatEmbedder({
    baseUrl: preset.baseUrl,
    apiKey: requireKey(preset, name),
    model: process.env.NOTES_EMBEDDING_MODEL ?? preset.defaultEmbeddingModel,
  });
}
