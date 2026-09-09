import { appDb } from "../db/context.ts";
import { notesEmbedder, notesSummarizer } from "../notes/context.ts";
import { campaignExists } from "../campaign/campaigns.ts";
import { deleteDocument, listDocuments } from "../notes/db.ts";
import { backfillSummaries, ingestDocument } from "../notes/ingest.ts";
import { isSupportedFile } from "../notes/shared.ts";
import { json, notFound } from "./http.ts";

/** Above this many files in one upload, summaries run as a backfill pass afterwards. */
const BATCH_THRESHOLD = 5;

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The event name is repeated inside the payload as `type`. Clients that only
 * read `data:` lines — including the one already in `PromptInput.tsx` — would
 * otherwise have to pair each `event:` line with the line after it, and get
 * silently undifferentiated events if they don't.
 */
function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

/**
 * POST /api/campaigns/:id/notes — multipart form, field `files`, one or many.
 *
 * Streams per-file progress because ingest is slow by nature: every file costs
 * an embedding round-trip, and a bulk drop of a campaign archive would
 * otherwise sit behind a silent request for minutes.
 */
export async function handleUploadNotes(req: Request, campaignId: number): Promise<Response> {
  if (!campaignExists(appDb(), campaignId)) return notFound(`No campaign ${campaignId}`);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected a multipart form body" }, 400);
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return json({ error: "No files supplied under the field name 'files'" }, 400);
  }

  const deferField = form.get("defer");
  const defer =
    typeof deferField === "string" ? deferField === "1" : files.length > BATCH_THRESHOLD;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      // Content is held in memory only for the file being ingested, so a large
      // archive does not need to fit in memory all at once.
      const contents = new Map<string, string>();
      let indexed = 0;
      let failed = 0;

      try {
        const db = appDb();
        const embedder = notesEmbedder();
        const summarizer = notesSummarizer();

        send("start", { total: files.length, deferSummaries: defer });

        for (const [i, file] of files.entries()) {
          const name = file.name;
          try {
            if (!isSupportedFile(name)) {
              throw new Error("Unsupported file type — expected .md, .markdown, .txt or .text");
            }
            if (file.size > MAX_FILE_BYTES) {
              throw new Error(`File is ${(file.size / 1e6).toFixed(1)} MB; limit is 25 MB`);
            }

            const content = await file.text();
            const result = await ingestDocument(
              db,
              embedder,
              summarizer,
              { campaignId, filename: name, content },
              { deferSummary: defer },
            );

            if (defer) contents.set(name, content);
            indexed++;
            send("file", {
              index: i,
              filename: name,
              status: "indexed",
              chunks: result.chunkCount,
              tokens: result.document.tokens,
              summarized: result.summarized,
            });
          } catch (err) {
            failed++;
            send("file", {
              index: i,
              filename: name,
              status: "failed",
              error: err instanceof Error ? err.message : "Ingest failed",
            });
          }
        }

        if (defer && indexed > 0) {
          send("summarizing", { pending: indexed });
          const done = await backfillSummaries(
            db,
            summarizer,
            (doc) => contents.get(doc.filename) ?? "",
            (completed, total) => send("summary_progress", { completed, total }),
            // Scoped: a bulk upload should never pick up another campaign's
            // unsummarized backlog and spend the user's budget on it.
            campaignId,
          );
          send("summarized", { count: done });
        }

        send("complete", { indexed, failed });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "Upload failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** GET /api/campaigns/:id/notes — the manifest, as the agent will eventually see it. */
export function handleListNotes(campaignId: number): Response {
  const db = appDb();
  if (!campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);

  const documents = listDocuments(db, campaignId);
  return json({
    count: documents.length,
    totalTokens: documents.reduce((sum, d) => sum + d.tokens, 0),
    documents,
  });
}

/** DELETE /api/notes/:id — ids are globally unique, so this needs no campaign. */
export function handleDeleteNote(docId: number): Response {
  deleteDocument(appDb(), docId);
  return json({ deleted: docId });
}
