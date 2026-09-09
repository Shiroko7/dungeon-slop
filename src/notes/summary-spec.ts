// The SDK's structured-output helper is built against zod v4, which ships as a
// subpath of the zod 3.25 already in this project. Schemas used with
// `zodOutputFormat` or `z.toJSONSchema` must come from here, not from the
// classic `zod` import the rest of the codebase uses.
import * as z from "zod/v4";
import type { DocumentSummary } from "./types.ts";

/**
 * Only this much of a document is sent for summarization. A session log's
 * character is established long before its end, and the manifest line is one
 * sentence — paying to read 200k tokens to write 30 is the kind of cost that
 * looks small per document and is not small across a corpus.
 */
const MAX_SAMPLE_CHARS = 120_000;
const HEAD_SHARE = 0.7;

export const SUMMARY_MAX_TOKENS = 1024;

export const SummarySchema = z.object({
  summary: z
    .string()
    .describe(
      "One sentence, max 30 words, naming what this document covers. Written to help " +
        "someone decide whether to open it. No preamble like 'This document'.",
    ),
  entities: z
    .array(z.string())
    .max(40)
    .describe(
      "Proper nouns a reader might search for: people, places, factions, items, " +
        "titles. Names only, no descriptions. Omit generic nouns.",
    ),
});

export const SUMMARY_JSON_SCHEMA = z.toJSONSchema(SummarySchema);

export const SUMMARY_SYSTEM_PROMPT =
  "You index tabletop RPG campaign notes so they can be searched later. " +
  "You are cataloguing, not summarizing for a reader: the summary line and the entity " +
  "list exist to help a search agent decide which file to open. Prefer the specific over " +
  "the evocative — proper nouns, session numbers, locations and outcomes beat atmosphere. " +
  "If the document is not campaign material (a rules reference, a shopping list, a stray " +
  "export), say so plainly in the summary rather than inventing narrative. " +
  "Reply with JSON only — no prose, no markdown fences.";

/**
 * Head-and-tail sample of an oversized document. The middle is what gets
 * dropped, because openings establish subject and endings establish outcome —
 * the two things a manifest line has to carry.
 */
function sample(text: string): string {
  if (text.length <= MAX_SAMPLE_CHARS) return text;

  const head = Math.floor(MAX_SAMPLE_CHARS * HEAD_SHARE);
  const tail = MAX_SAMPLE_CHARS - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - MAX_SAMPLE_CHARS} characters omitted ...]\n\n${text.slice(-tail)}`;
}

export function buildSummaryPrompt(filename: string, text: string): string {
  return `Filename: ${filename}\n\n---\n\n${sample(text)}`;
}

/**
 * Pull the summary out of a raw model response.
 *
 * Cheap models fence their JSON in markdown or prepend a sentence of preamble
 * even when told not to, and that is not worth a retry when the payload is
 * sitting right there. Extract the outermost JSON object, then validate — a
 * response that is merely untidy succeeds, one that is actually wrong still
 * fails.
 */
export function parseSummary(raw: string): DocumentSummary {
  const candidates: string[] = [raw];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = SummarySchema.parse(JSON.parse(candidate.trim()));
      return { summary: parsed.summary, entities: parsed.entities };
    } catch {
      // Try the next extraction strategy.
    }
  }

  throw new Error(`Could not parse a summary from the model response: ${raw.slice(0, 200)}`);
}
