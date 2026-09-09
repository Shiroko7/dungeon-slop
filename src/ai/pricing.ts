/**
 * Per-model rates, in USD per 1 million tokens.
 *
 * These are NOT fetched from anywhere. The Gemini API exposes no pricing
 * endpoint (ListModels returns token limits and capabilities, no prices), so
 * this table is maintained by hand.
 *
 *   Gemini    https://ai.google.dev/pricing
 *   Anthropic https://claude.com/pricing#api
 *
 * A `null` rate means "not filled in yet". Nulls are deliberate: an unpriced
 * model reports token counts and an explicit "rate not set" rather than a
 * plausible-looking dollar figure that happens to be invented. Fill a rate in
 * and every historical row reprices on the next read, because the ledger stores
 * raw tokens and prices at read time.
 *
 * `thinking` is the rate charged for reasoning tokens. On Gemini these bill at
 * the normal output rate, so leaving it null falls back to `output` rather than
 * dropping the cost — set it explicitly only if that stops being true.
 */
export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number | null;
  /** USD per 1M output tokens. */
  output: number | null;
  /** USD per 1M reasoning tokens; falls back to `output` when null. */
  thinking?: number | null;
}

export const RATES: Record<string, ModelRate> = {
  // ── Gemini ────────────────────────────────────────────────────────────────
  "gemini-3.8-flash": { input: null, output: null },
  "gemini-3.7-flash": { input: null, output: null },
  "gemini-3.6-flash": { input: null, output: null },
  "gemini-3.5-flash": { input: null, output: null },
  "gemini-3.5-flash-lite": { input: null, output: null },
  "gemini-3.1-flash-lite": { input: null, output: null },
  "gemini-3.1-pro-preview": { input: null, output: null },
  "gemini-3-flash-preview": { input: null, output: null },
  "gemini-flash-latest": { input: null, output: null },
  "gemini-flash-lite-latest": { input: null, output: null },
  "gemini-pro-latest": { input: null, output: null },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  "claude-haiku-4-5-20251001": { input: null, output: null },

  // ── Local: genuinely free, so zero is a fact rather than a placeholder ─────
  "qwen3:8b": { input: 0, output: 0 },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface CostBreakdown {
  /** Null when the model has no rate on file - render tokens only. */
  usd: number | null;
  /** True when a rate is missing, so the UI can say so instead of showing $0. */
  rateMissing: boolean;
}

/**
 * The API reports the model it actually served, which for a rolling alias is a
 * versioned id ("gemini-3.6-flash" answering as "3.6-flash-07-2026"). Match the
 * exact id first, then the longest prefix, so a versioned response still prices.
 */
function lookupRate(model: string): ModelRate | undefined {
  const exact = RATES[model];
  if (exact) return exact;

  let best: { id: string; rate: ModelRate } | undefined;
  for (const [id, rate] of Object.entries(RATES)) {
    if (!model.startsWith(id) && !id.startsWith(model)) continue;
    if (best === undefined || id.length > best.id.length) best = { id, rate };
  }
  return best?.rate;
}

export function costOf(model: string, tokens: TokenCounts): CostBreakdown {
  const rate = lookupRate(model);
  if (rate === undefined || rate.input === null || rate.output === null) {
    return { usd: null, rateMissing: true };
  }

  const thinkingRate = rate.thinking ?? rate.output;
  const usd =
    (tokens.inputTokens * rate.input +
      tokens.outputTokens * rate.output +
      tokens.thinkingTokens * thinkingRate) /
    1_000_000;

  return { usd, rateMissing: false };
}

/** True when at least one rate is filled in, so the UI can hide dollars entirely. */
export function anyRatesConfigured(): boolean {
  return Object.values(RATES).some((r) => r.input !== null && r.output !== null);
}
