import { describe, test, expect } from "bun:test";
import { costOf, RATES, type ModelRate } from "./pricing.ts";

/**
 * The rate table ships with nulls on purpose, so these tests inject their own
 * rates rather than asserting against whatever is currently filled in. That
 * keeps them meaningful once real prices land.
 */
function withRate<T>(model: string, rate: ModelRate, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(RATES, model);
  const previous = RATES[model];
  RATES[model] = rate;
  try {
    return fn();
  } finally {
    if (had) RATES[model] = previous as ModelRate;
    else delete RATES[model];
  }
}

describe("costOf", () => {
  test("prices input, output and thinking tokens per million", () => {
    const result = withRate("test-model", { input: 1, output: 10 }, () =>
      costOf("test-model", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        thinkingTokens: 0,
      }),
    );
    expect(result.rateMissing).toBe(false);
    expect(result.usd).toBeCloseTo(11, 10);
  });

  test("thinking tokens bill at the output rate by default", () => {
    const result = withRate("test-model", { input: 0, output: 4 }, () =>
      costOf("test-model", { inputTokens: 0, outputTokens: 0, thinkingTokens: 500_000 }),
    );
    expect(result.usd).toBeCloseTo(2, 10);
  });

  test("an explicit thinking rate overrides the output rate", () => {
    const result = withRate("test-model", { input: 0, output: 4, thinking: 1 }, () =>
      costOf("test-model", { inputTokens: 0, outputTokens: 0, thinkingTokens: 1_000_000 }),
    );
    expect(result.usd).toBeCloseTo(1, 10);
  });

  test("reports rateMissing rather than inventing a price", () => {
    const result = withRate("test-model", { input: null, output: null }, () =>
      costOf("test-model", { inputTokens: 1000, outputTokens: 1000, thinkingTokens: 0 }),
    );
    expect(result.usd).toBeNull();
    expect(result.rateMissing).toBe(true);
  });

  test("a half-filled rate is treated as missing, not as zero", () => {
    const result = withRate("test-model", { input: 5, output: null }, () =>
      costOf("test-model", { inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0 }),
    );
    expect(result.usd).toBeNull();
    expect(result.rateMissing).toBe(true);
  });

  test("an unknown model is missing rather than free", () => {
    const result = costOf("some-model-nobody-listed", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      thinkingTokens: 0,
    });
    expect(result.usd).toBeNull();
    expect(result.rateMissing).toBe(true);
  });

  test("a versioned response id prices off its base model", () => {
    // Gemini answers a rolling alias with a dated id; it must still price.
    const result = withRate("gemini-3.6-flash", { input: 2, output: 2 }, () =>
      costOf("gemini-3.6-flash-07-2026", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        thinkingTokens: 0,
      }),
    );
    expect(result.rateMissing).toBe(false);
    expect(result.usd).toBeCloseTo(2, 10);
  });

  test("a genuinely free local model prices at zero, not as missing", () => {
    const result = costOf("qwen3:8b", {
      inputTokens: 5_000_000,
      outputTokens: 5_000_000,
      thinkingTokens: 5_000_000,
    });
    expect(result.rateMissing).toBe(false);
    expect(result.usd).toBe(0);
  });

  test("every shipped rate is either fully set or fully null", () => {
    // A half-filled entry silently understates the bill, so guard the table.
    for (const [model, rate] of Object.entries(RATES)) {
      const filled = [rate.input, rate.output].filter((v) => v !== null).length;
      expect(`${model}:${filled}`).toMatch(/:(0|2)$/);
    }
  });
});
