import { appDb } from "../db/context.ts";
import { lazyNotesProviders, notesProviderMetadata } from "../notes/context.ts";
import { campaignExists } from "../campaign/campaigns.ts";
import { deleteDocument, documentsMissingSummary, listDocuments } from "../notes/db.ts";
import { ingestDocument, retryDocument, summarizeRevision, type IngestResult } from "../notes/ingest.ts";
import { MAX_NOTE_BATCH_BYTES, MAX_NOTE_FILES, MAX_NOTE_FILE_BYTES, isSupportedFile } from "../notes/shared.ts";
import { json, notFound, readJson } from "./http.ts";
import { operationStream } from "./stream.ts";

// Bounds multipart parsing, retained bodies, and queued provider work together.
let activeBatches = 0;
const MAX_BATCHES = 2;
const MAX_BODY_BYTES = MAX_NOTE_BATCH_BYTES + 1024 * 1024;
type Send = (event: string, data: Record<string, unknown>) => void;

async function boundedForm(req: Request): Promise<FormData> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("Upload exceeds the 20 MiB batch limit");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Expected a multipart form body");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  req.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      req.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("Upload exceeds the 20 MiB batch limit");
      chunks.push(new Uint8Array(part.value));
    }
    req.signal.throwIfAborted();
    return await new Response(new Blob(chunks), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } finally {
    req.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function notesStream(req: Request, run: (send: Send, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder();
  return new Response(operationStream(req, async (controller, signal) => {
    const send: Send = (event, data) => controller.enqueue(encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`));
    const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": processing\n\n")), 15_000);
    try { await run(send, signal); }
    catch (error) {
      if (!signal.aborted) send("error", { error: error instanceof Error ? error.message : "Notes processing failed" });
    } finally { clearInterval(heartbeat); activeBatches--; }
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

function outcome(result: IngestResult): Record<string, unknown> {
  return { docId: result.document.id,
    status: result.unchanged ? "unchanged" : result.summarized ? "indexed" : "partial",
    chunks: result.chunkCount, error: result.document.summaryError ?? undefined,
    summarized: result.summarized };
}

export async function handleUploadNotes(req: Request, campaignId: number): Promise<Response> {
  if (!campaignExists(appDb(), campaignId)) return notFound(`No campaign ${campaignId}`);
  if (activeBatches >= MAX_BATCHES) return json({ error: "Notes processing is busy. Retry shortly." }, 429);
  activeBatches++;
  let files: File[];
  try {
    const form = await boundedForm(req);
    files = form.getAll("files").filter((file): file is File => file instanceof File);
    if (!files.length || files.length > MAX_NOTE_FILES) throw new Error(`Choose between 1 and ${MAX_NOTE_FILES} files`);
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_NOTE_BATCH_BYTES) throw new Error("Upload exceeds the 20 MiB batch limit");
  } catch (error) {
    activeBatches--;
    return json({ error: error instanceof Error ? error.message : "Invalid upload" }, 400);
  }
  return notesStream(req, async (send, signal) => {
    const db = appDb();
    const { embedder, summarizer } = lazyNotesProviders();
    const handled = new Set<number>();
    let indexed = 0;
    let failed = 0;
    send("start", { total: files.length });
    for (const [index, file] of files.entries()) {
      signal.throwIfAborted();
      try {
        if (!isSupportedFile(file.name)) throw new Error("Unsupported file type; choose .md, .markdown, .txt or .text");
        if (file.size > MAX_NOTE_FILE_BYTES) throw new Error("File exceeds the 5 MiB limit");
        const result = await ingestDocument(db, embedder, summarizer,
          { campaignId, filename: file.name, content: await file.text() }, { signal });
        handled.add(result.document.id);
        indexed++;
        send("file", { index, filename: file.name, ...outcome(result) });
      } catch (error) {
        signal.throwIfAborted();
        failed++;
        send("file", { index, filename: file.name, status: "failed",
          error: error instanceof Error ? error.message : "Indexing failed" });
      }
    }
    const backlog = documentsMissingSummary(db, campaignId).filter((doc) => !handled.has(doc.id) && doc.sourceAvailable);
    for (const [i, doc] of backlog.entries()) {
      signal.throwIfAborted();
      send("summary_progress", { completed: i, total: backlog.length });
      await summarizeRevision(db, summarizer, doc.id, signal);
    }
    send("complete", { indexed, failed });
  });
}

/** Resume stored work; rebuilding is an explicit action on selected notes only. */
export async function handleRetryNotes(req: Request, campaignId: number): Promise<Response> {
  const db = appDb();
  if (!campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);
  const body = await readJson<{ ids?: unknown; reindex?: unknown }>(req);
  if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_NOTE_FILES ||
      body.ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      (body.reindex !== undefined && typeof body.reindex !== "boolean")) {
    return json({ error: `Provide 1–${MAX_NOTE_FILES} note IDs` }, 400);
  }
  const ids = [...new Set(body.ids as number[])];
  const documents = listDocuments(db, campaignId).filter((doc) => ids.includes(doc.id));
  if (documents.length !== ids.length) return notFound("A note does not belong to this campaign");
  if (activeBatches >= MAX_BATCHES) return json({ error: "Notes processing is busy. Retry shortly." }, 429);
  activeBatches++;
  return notesStream(req, async (send, signal) => {
    const { embedder, summarizer } = lazyNotesProviders();
    send("start", { total: documents.length });
    for (const [index, doc] of documents.entries()) {
      signal.throwIfAborted();
      try {
        const result = await retryDocument(db, embedder, summarizer, doc.id, { signal, force: body.reindex === true });
        send("file", { index, filename: doc.filename, ...outcome(result) });
      } catch (error) {
        signal.throwIfAborted();
        send("file", { index, filename: doc.filename, status: "failed",
          error: error instanceof Error ? error.message : "Retry failed" });
      }
    }
    send("complete", {});
  });
}

export function handleListNotes(campaignId: number): Response {
  const db = appDb();
  if (!campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);
  const documents = listDocuments(db, campaignId);
  return json({ count: documents.length, totalTokens: documents.reduce((sum, doc) => sum + doc.tokens, 0), documents });
}

export function handleNotesProviders(): Response { return json(notesProviderMetadata()); }

export function handleDeleteNote(docId: number): Response {
  deleteDocument(appDb(), docId);
  return json({ deleted: docId });
}
