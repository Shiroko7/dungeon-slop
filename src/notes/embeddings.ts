import type { EmbeddingProvider } from "./types.ts";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
// voyage-4-lite: $0.02 per 1M tokens with the first 200M free, so a 25M-token
// corpus indexes eight times over inside the free allocation.
const DEFAULT_MODEL = process.env.VOYAGE_MODEL ?? "voyage-4-lite";

/** Voyage caps a request at 128 inputs; stay under it and under its token cap. */
const MAX_BATCH_ITEMS = 96;
const MAX_BATCH_CHARS = 320_000;

const MAX_ATTEMPTS = 4;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Group inputs so no request exceeds Voyage's per-call item and size limits.
 * A single input larger than the whole char budget still goes out alone rather
 * than being dropped — the API will reject it with a message worth reading.
 */
function batch(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const text of texts) {
    const wouldOverflow = current.length >= MAX_BATCH_ITEMS || chars + text.length > MAX_BATCH_CHARS;
    if (wouldOverflow && current.length > 0) {
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

async function requestBatch(
  apiKey: string,
  model: string,
  texts: string[],
  kind: "document" | "query",
): Promise<Float32Array[]> {
  let lastError = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model, input_type: kind }),
      signal: AbortSignal.timeout(120_000),
    });

    if (response.ok) {
      const data = (await response.json()) as VoyageResponse;
      // Index order is documented but not guaranteed by the wire format; sort
      // rather than trust it, because a silent shuffle here maps every chunk to
      // the wrong vector and nothing downstream can detect it.
      const sorted = [...data.data].sort((a, b) => a.index - b.index);
      if (sorted.length !== texts.length) {
        throw new Error(
          `Voyage returned ${sorted.length} embeddings for ${texts.length} inputs`,
        );
      }
      return sorted.map((row) => Float32Array.from(row.embedding));
    }

    lastError = `${response.status} ${await response.text()}`;
    if (!isRetryable(response.status)) break;
    await backoff(attempt);
  }

  throw new Error(`Voyage embeddings failed: ${lastError}`);
}

export function createVoyageProvider(
  apiKey: string = process.env.VOYAGE_API_KEY ?? "",
  model: string = DEFAULT_MODEL,
): EmbeddingProvider {
  if (apiKey === "") {
    throw new Error("VOYAGE_API_KEY environment variable is not set");
  }

  return {
    model,
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      for (const group of batch(texts)) {
        out.push(...(await requestBatch(apiKey, model, group, kind)));
      }
      return out;
    },
  };
}

// ─── similarity ───────────────────────────────────────────────────────────────

/** In-place L2 normalisation, so cosine similarity reduces to a dot product. */
export function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}
