import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { useNotesStore } from "./notes-store.ts";
import { api } from "./api.ts";
import { deferred } from "../test-fixtures.ts";

afterEach(() => { useNotesStore.getState().close(); mock.restore(); });

test("stream failure remains visible after manifest refresh and settles pending files", async () => {
  spyOn(api.notes, "list").mockResolvedValue([]);
  await useNotesStore.getState().fetchDocuments(1);
  spyOn(globalThis, "fetch").mockResolvedValue(new Response('data: {"type":"error","error":"Offline"}\n\n'));
  await useNotesStore.getState().uploadFiles(1, [new File(["content"], "a.md")]);
  expect(useNotesStore.getState().error).toBe("Offline");
  expect(useNotesStore.getState().uploadLog[0]?.status).toBe("failed");
  expect(useNotesStore.getState().isUploading).toBe(false);
});

test("a stream without completion cannot leave files falsely pending or claim success", async () => {
  spyOn(api.notes, "list").mockResolvedValue([]);
  await useNotesStore.getState().fetchDocuments(1);
  spyOn(globalThis, "fetch").mockResolvedValue(new Response('data: {"type":"start","total":1}\n\n'));
  await useNotesStore.getState().uploadFiles(1, [new File(["content"], "a.md")]);
  expect(useNotesStore.getState().error).toContain("interrupted");
  expect(useNotesStore.getState().uploadLog[0]?.status).toBe("failed");
});

test("cancel aborts the request and reports interrupted files, while navigation clears owned state", async () => {
  spyOn(api.notes, "list").mockResolvedValue([]);
  await useNotesStore.getState().fetchDocuments(1);
  const entered = deferred<AbortSignal>();
  spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init!.signal!;
    entered.resolve(signal);
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return new Response();
  }) as typeof fetch);
  const upload = useNotesStore.getState().uploadFiles(1, [new File(["content"], "a.md")]);
  const signal = await entered.promise;
  useNotesStore.getState().cancelUpload();
  await upload;
  expect(signal.aborted).toBe(true);
  expect(useNotesStore.getState().uploadLog[0]?.status).toBe("cancelled");
  expect(useNotesStore.getState().error).toContain("Cancelled");
  await useNotesStore.getState().fetchDocuments(2);
  expect(useNotesStore.getState().uploadLog).toEqual([]);
  expect(useNotesStore.getState().error).toBeNull();
});
