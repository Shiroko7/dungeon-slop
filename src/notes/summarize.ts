import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
  SummarySchema,
  buildSummaryPrompt,
  parseSummary,
} from "./summary-spec.ts";
import type { DocumentSummary, SummarizerProvider } from "./types.ts";

/** High volume, low judgement — the cheapest Anthropic model that writes a usable summary. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

export function createAnthropicClient(): Anthropic {
  // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or
  // an `ant auth login` profile, in that order.
  return new Anthropic();
}

/**
 * Anthropic-native summarizer. Kept alongside the OpenAI-compatible providers
 * because `messages.parse()` constrains decoding to the schema and hands back a
 * validated object, which no compatibility layer guarantees.
 */
export function createAnthropicSummarizer(
  client: Anthropic = createAnthropicClient(),
  model: string = process.env.NOTES_SUMMARY_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
): SummarizerProvider {
  return {
    name: "anthropic",
    model,

    async summarize(filename: string, text: string): Promise<DocumentSummary> {
      const message = await client.messages.parse({
        model,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildSummaryPrompt(filename, text) }],
        output_config: { format: zodOutputFormat(SummarySchema) },
      });

      const parsed = message.parsed_output;
      if (!parsed) {
        throw new Error(`Summarization returned no parseable output for "${filename}"`);
      }
      return { summary: parsed.summary, entities: parsed.entities };
    },
  };
}

// ─── bulk path ────────────────────────────────────────────────────────────────

export interface BatchInput {
  docId: number;
  filename: string;
  text: string;
}

const POLL_INTERVAL_MS = 15_000;

/**
 * Summarize many documents through Anthropic's Batch API at half price. Worth
 * the extra machinery for a bulk backfill and not for a single upload, which
 * would wait minutes for a result the direct path returns in seconds.
 *
 * Anthropic-specific by design: the equivalent on other providers is either
 * absent or shaped differently enough that one abstraction over all of them
 * would hide the thing that makes this worth calling. Providers without a batch
 * endpoint fall back to sequential direct calls via `summarizeSequentially`.
 *
 * Results are keyed by `custom_id`, never by position — the API returns them in
 * arbitrary order.
 */
export async function summarizeDocumentsBatched(
  client: Anthropic,
  inputs: BatchInput[],
  model: string = DEFAULT_ANTHROPIC_MODEL,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, DocumentSummary>> {
  const results = new Map<number, DocumentSummary>();
  if (inputs.length === 0) return results;

  const format = zodOutputFormat(SummarySchema);

  const batch = await client.messages.batches.create({
    requests: inputs.map((input) => ({
      custom_id: `doc-${input.docId}`,
      params: {
        model,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: buildSummaryPrompt(input.filename, input.text) }],
        output_config: { format },
      },
    })),
  });

  let status = batch.processing_status;
  while (status !== "ended") {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const current = await client.messages.batches.retrieve(batch.id);
    status = current.processing_status;
    onProgress?.(current.request_counts.succeeded + current.request_counts.errored, inputs.length);
  }

  for await (const entry of await client.messages.batches.results(batch.id)) {
    if (entry.result.type !== "succeeded") continue;

    const docId = Number(entry.custom_id.replace(/^doc-/, ""));
    if (!Number.isFinite(docId)) continue;

    const text = entry.result.message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    try {
      // `parsed_output` is a convenience of the non-batch `.parse()` path; batch
      // results arrive as raw content, so validate here instead of trusting them.
      results.set(docId, parseSummary(text));
    } catch {
      // A document that fails to parse stays unsummarized and is picked up by
      // the next backfill; it must not abort the whole batch.
    }
  }

  return results;
}

/**
 * Provider-neutral bulk fallback: summarize one at a time, skipping failures.
 * Slower and full price, but it works against every provider and a rate-limited
 * free tier is throttled by its own quota long before this loop is the problem.
 */
export async function summarizeSequentially(
  summarizer: SummarizerProvider,
  inputs: BatchInput[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, DocumentSummary>> {
  const results = new Map<number, DocumentSummary>();

  for (const [i, input] of inputs.entries()) {
    try {
      results.set(input.docId, await summarizer.summarize(input.filename, input.text));
    } catch {
      // Leave it unsummarized for the next backfill rather than failing the run.
    }
    onProgress?.(i + 1, inputs.length);
  }

  return results;
}
