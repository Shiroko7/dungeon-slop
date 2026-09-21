import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as context from "../db/context.ts";
import * as providers from "../notes/context.ts";
import { createCampaign } from "../campaign/campaigns.ts";
import { getDocument, openNotesDb } from "../notes/db.ts";
import { handleRetryNotes, handleUploadNotes } from "./upload-notes.ts";
import { deferred } from "../test-fixtures.ts";
import type { EmbeddingProvider, SummarizerProvider } from "../notes/types.ts";

let db: Database;
let embeddingCalls: number;
let summaryCalls: number;
let embedder: EmbeddingProvider;
let summarizer: SummarizerProvider;
beforeEach(() => {
  db = openNotesDb(":memory:");
  createCampaign(db, { name: "Notes test" });
  embeddingCalls = summaryCalls = 0;
  embedder = { model: "stub", embed: async (texts) => { embeddingCalls++; return texts.map(() => Float32Array.from([1, 2])); } };
  summarizer = { name: "stub", model: "stub", summarize: async (_filename, source) => { summaryCalls++; return { summary: source, entities: [] }; } };
  spyOn(context, "appDb").mockImplementation(() => db);
  spyOn(providers, "lazyNotesProviders").mockImplementation(() => ({ embedder, summarizer }));
});
afterEach(() => { mock.restore(); db.close(); });

function upload(files: File[], signal?: AbortSignal) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return handleUploadNotes(new Request("http://localhost/api/campaigns/1/notes", { method: "POST", body: form, signal }), 1);
}
function retry(ids: number[], reindex = false) {
  return handleRetryNotes(new Request("http://localhost/api/campaigns/1/notes/retry", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, reindex }),
  }), 1);
}
async function events(response: Response) {
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

test("upload outcomes distinguish indexed, unchanged, and invalid files", async () => {
  const file = new File(["Source"], "a.md");
  const first = await events(await upload([file, new File(["invalid"], "bad.pdf")]));
  expect(first.filter((event) => event.type === "file").map((event) => event.status)).toEqual(["indexed", "failed"]);
  const second = await events(await upload([file]));
  expect(second.find((event) => event.type === "file").status).toBe("unchanged");
  expect(embeddingCalls).toBe(1);
  expect(summaryCalls).toBe(1);
});

test("summary failure is shown as partial; persisted retry calls only the missing stage", async () => {
  summarizer.summarize = async () => { summaryCalls++; throw new Error("Summary offline"); };
  const initial = await events(await upload([new File(["Source"], "a.md")]));
  expect(initial.find((event) => event.type === "file")).toMatchObject({ status: "partial", error: "Summary offline" });
  summarizer.summarize = async () => { summaryCalls++; return { summary: "Recovered", entities: [] }; };
  const retried = await events(await retry([1]));
  expect(retried.find((event) => event.type === "file").status).toBe("indexed");
  expect(embeddingCalls).toBe(1);
  expect(summaryCalls).toBe(2);
  await events(await retry([1]));
  expect(summaryCalls).toBe(2);
});

test("retry refuses IDs owned by another campaign before any provider calls", async () => {
  createCampaign(db, { name: "Other" });
  db.run("INSERT INTO documents (campaign_id, filename, uploaded_at, content_hash) VALUES (2, 'other.md', 1, '')");
  expect((await retry([1])).status).toBe(404);
  expect(embeddingCalls).toBe(0);
});

test("upload limits are enforced before work, with oversized files reported per file", async () => {
  expect((await upload(Array.from({ length: 21 }, (_, i) => new File(["x"], `${i}.md`)))).status).toBe(400);
  const result = await events(await upload([new File(["x".repeat(5 * 1024 * 1024 + 1)], "large.md")]));
  expect(result.find((event) => event.type === "file")).toMatchObject({ status: "failed", error: "File exceeds the 5 MiB limit" });
  expect(embeddingCalls).toBe(0);
});

test("response cancellation aborts provider work and saves a retryable source", async () => {
  const entered = deferred<AbortSignal>();
  const stopped = deferred<void>();
  embedder.embed = async (_texts, _kind, signal) => {
    entered.resolve(signal!);
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => { stopped.resolve(); reject(signal!.reason); }, { once: true }));
    return [];
  };
  const response = await upload([new File(["Saved source"], "a.md")]);
  const signal = await entered.promise;
  await response.body!.cancel();
  await stopped.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(signal.aborted).toBe(true);
  expect(getDocument(db, 1)).toMatchObject({ activeRevision: 0, indexStatus: "cancelled", retrySourceAvailable: true });
});
