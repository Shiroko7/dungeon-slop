import { expect, test } from "bun:test";
import { validateAIRequest } from "./ownership.ts";

// The settings store keeps null for "provider default"; a request carrying that
// must not be rejected (it was: every AI action failed until a level was picked).
test("null model and thinking level mean 'provider default', not invalid", () => {
  expect(validateAIRequest({ prompt: "x", model: null, thinkingLevel: null })).toBeNull();
  expect(validateAIRequest({ prompt: "x", thinkingLevel: "low" })).toBeNull();
  expect(validateAIRequest({ prompt: "x", thinkingLevel: "loud" })?.status).toBe(400);
});
