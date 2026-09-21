import { appDb } from "../db/context.ts";
import { notesEmbedder } from "../notes/context.ts";
import { searchNotes } from "../notes/retrieval.ts";
import { NoteAccessError, readNote } from "../notes/reader.ts";
import { badRequest, json, readJson } from "./http.ts";

let activeSearches = 0;

export async function handleSearchNotes(req: Request, campaignId: number): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("Expected search options as JSON");
  if (activeSearches >= 4) return json({ error: "Search is busy. Retry shortly.", code: "search_busy" }, 429);
  activeSearches++;
  try { return json(await searchNotes(appDb(), campaignId, body, notesEmbedder, req.signal)); }
  catch (error) {
    if (req.signal.aborted) return json({ error: "Search cancelled", code: "cancelled" }, 499);
    if (error instanceof NoteAccessError) return json({ error: error.message, code: error.code }, error.status);
    throw error;
  } finally { activeSearches--; }
}

export function handleReadNote(req: Request, campaignId: number, documentId: number, revision: number): Response {
  const rawChunk = new URL(req.url).searchParams.get("chunk");
  const chunkId = rawChunk === null ? undefined : Number(rawChunk);
  if (chunkId !== undefined && (!Number.isSafeInteger(chunkId) || chunkId <= 0)) return badRequest("Invalid chunk ID");
  try { return json(readNote(appDb(), campaignId, documentId, revision, chunkId)); }
  catch (error) {
    if (error instanceof NoteAccessError) return json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
