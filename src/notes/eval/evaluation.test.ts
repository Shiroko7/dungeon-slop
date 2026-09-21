import { expect, test } from "bun:test";
import { evaluateRetrieval } from "./evaluate.ts";

test("frozen 36-query corpus meets hybrid hit@5 target with zero cross-campaign results", async () => {
  const report = await evaluateRetrieval();
  expect(report.queries).toBeGreaterThanOrEqual(30);
  expect(report.corpusSha256).toBe("4e7054982bb3f7c1c700f3a507118ad029b5547ac4e398d0109d873bb4369d98");
  expect(report.modes.hybrid.hitAt5).toBeGreaterThanOrEqual(report.targetHitAt5);
  for (const mode of Object.values(report.modes)) expect(mode.leaks).toBe(0);
  expect(report.modes.lexical.missingEmpty).toBe(report.modes.lexical.missingQueries);
});
