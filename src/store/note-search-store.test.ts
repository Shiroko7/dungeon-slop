import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { api } from "./api.ts";
import { useNoteSearchStore as store } from "./note-search-store.ts";
import { deferred } from "../test-fixtures.ts";
import type { NoteSearchResult } from "../notes/retrieval-types.ts";

afterEach(() => { store.getState().close(); mock.restore(); });
function result(query: string): NoteSearchResult {
  return { query, mode: "lexical", usedMode: "lexical", status: "no-matches", results: [], tokenBudget: 3000,
    tokensUsed: 0, warnings: [], diagnostics: { indexedChunks: 0, lexicalCandidates: 0, semanticCandidates: 0, embeddingModel: null } };
}
test("reversed searches cannot display results for an older query", async () => {
  const first = deferred<NoteSearchResult>(), second = deferred<NoteSearchResult>();
  spyOn(api.notes, "search").mockImplementation((_id, input) => input.query === "first" ? first.promise : second.promise);
  store.getState().open(1); store.getState().change({ query: "first" });
  const a = store.getState().search();
  store.getState().change({ query: "second" });
  const b = store.getState().search();
  second.resolve(result("second")); await b;
  first.resolve(result("first")); await a;
  expect(store.getState().result?.query).toBe("second");
});
test("cancel aborts the request, and late results cannot cross campaigns", async () => {
  const gate = deferred<NoteSearchResult>();
  let signal: AbortSignal | undefined;
  spyOn(api.notes, "search").mockImplementation((_id, _input, supplied) => { signal = supplied; return gate.promise; });
  store.getState().open(1); store.getState().change({ query: "old campaign" });
  const pending = store.getState().search();
  store.getState().cancel();
  expect(signal?.aborted).toBe(true);
  expect(store.getState().error).toContain("cancelled");
  store.getState().open(2);
  gate.resolve(result("old campaign")); await pending;
  expect(store.getState().campaignId).toBe(2);
  expect(store.getState().result).toBeNull();
  expect(store.getState().error).toBeNull();
});
test("reader round-trip retains search, but changed filters clear stale results", async () => {
  spyOn(api.notes, "search").mockImplementation(async () => result("Mira"));
  store.getState().open(1); store.getState().change({ query: "Mira" }); await store.getState().search();
  store.getState().open(1);
  expect(store.getState().result?.query).toBe("Mira");
  store.getState().change({ documentIds: [] });
  expect(store.getState().result).toBeNull();
  expect(store.getState().input.documentIds).toEqual([]);
});
