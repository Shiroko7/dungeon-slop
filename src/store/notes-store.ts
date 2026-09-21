import { create } from "zustand";
import { api } from "./api.ts";
import { MAX_NOTE_BATCH_BYTES, MAX_NOTE_FILES } from "../notes/shared.ts";
import type { NoteDocument, NotesProviders } from "../notes/types.ts";

export interface UploadEntry {
  filename: string;
  status: "pending" | "indexed" | "partial" | "unchanged" | "failed" | "cancelled";
  chunks?: number;
  error?: string;
}

interface NotesState {
  campaignId: number | null;
  documents: NoteDocument[];
  providers: NotesProviders | null;
  providerError: string | null;
  isLoading: boolean;
  isUploading: boolean;
  uploadLog: UploadEntry[];
  summaryProgress: { completed: number; total: number } | null;
  error: string | null;
  fetchDocuments: (campaignId: number) => Promise<void>;
  fetchProviders: () => Promise<void>;
  uploadFiles: (campaignId: number, files: File[]) => Promise<void>;
  retryDocuments: (campaignId: number, ids: number[], reindex?: boolean) => Promise<void>;
  cancelUpload: () => void;
  removeDocument: (id: number) => Promise<void>;
  setError: (error: string | null) => void;
  close: () => void;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

let notesEpoch = 0;
let viewEpoch = 0;
let uploadAbort: AbortController | null = null;

async function runBatch(campaignId: number, filenames: string[], url: string, init: RequestInit): Promise<void> {
  const epoch = viewEpoch;
  const store = useNotesStore;
  if (store.getState().isUploading || store.getState().campaignId !== campaignId) return;
  const update: typeof store.setState = (partial) => {
    if (epoch === viewEpoch) store.setState(partial);
  };
  const abort = new AbortController();
  uploadAbort = abort;
  update({ isUploading: true, error: null, summaryProgress: null,
    uploadLog: filenames.map((filename) => ({ filename, status: "pending" })) });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    const response = await fetch(url, { ...init, signal: abort.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Server responded with ${response.status}`);
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      abort.signal.throwIfAborted();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event.type === "file") {
          const statuses = ["indexed", "partial", "unchanged", "failed"];
          update((state) => ({ uploadLog: state.uploadLog.map((entry, index) => index !== event.index ? entry : {
            ...entry, status: statuses.includes(String(event.status)) ? event.status as UploadEntry["status"] : "failed",
            chunks: event.chunks as number | undefined, error: event.error as string | undefined,
          }) }));
        } else if (event.type === "summary_progress") {
          update({ summaryProgress: { completed: Number(event.completed), total: Number(event.total) } });
        } else if (event.type === "complete") {
          complete = true;
        } else if (event.type === "error" || event.error) {
          throw new Error(String(event.error ?? "Processing failed"));
        }
      }
    }
    if (!complete) throw new Error("Connection interrupted. Refresh or retry saved notes to check what completed.");
  } catch (error) {
    const detail = abort.signal.aborted ? "Cancelled. Completed notes remain available; retry saved notes or reselect files that had not started."
      : message(error, "Upload failed");
    update((state) => ({ error: detail,
      uploadLog: state.uploadLog.map((entry) => entry.status === "pending"
        ? { ...entry, status: abort.signal.aborted ? "cancelled" : "failed", error: detail } : entry) }));
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    if (uploadAbort === abort) uploadAbort = null;
    update({ isUploading: false, summaryProgress: null });
    if (epoch === viewEpoch) await store.getState().fetchDocuments(campaignId);
  }
}

export const useNotesStore = create<NotesState>()((set, get) => ({
  campaignId: null, documents: [], providers: null, providerError: null,
  isLoading: false, isUploading: false, uploadLog: [], summaryProgress: null, error: null,
  setError: (error) => set({ error }),
  cancelUpload: () => uploadAbort?.abort(),
  close: () => {
    uploadAbort?.abort();
    ++viewEpoch;
    ++notesEpoch;
    set({ campaignId: null, documents: [], isLoading: false, isUploading: false,
      uploadLog: [], summaryProgress: null, error: null });
  },
  fetchProviders: async () => {
    try { set({ providers: await api.notes.providers(), providerError: null }); }
    catch (error) { set({ providerError: message(error, "Could not load notes providers") }); }
  },
  fetchDocuments: async (campaignId) => {
    if (get().campaignId !== campaignId) {
      uploadAbort?.abort();
      ++viewEpoch;
      set({ campaignId, documents: [], uploadLog: [], isUploading: false, summaryProgress: null, error: null });
    }
    const epoch = ++notesEpoch;
    const update: typeof set = (partial) => { if (epoch === notesEpoch) set(partial); };
    update({ isLoading: true });
    try { update({ documents: await api.notes.list(campaignId) }); }
    catch (error) { update({ error: message(error, "Could not load notes") }); }
    finally { update({ isLoading: false }); }
  },
  uploadFiles: async (campaignId, files) => {
    if (!files.length || get().isUploading) return;
    if (files.length > MAX_NOTE_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_NOTE_BATCH_BYTES) {
      set({ error: "Choose up to 20 files totaling at most 20 MiB." });
      return;
    }
    const form = new FormData();
    for (const file of files) form.append("files", file);
    await runBatch(campaignId, files.map((file) => file.name), `/api/campaigns/${campaignId}/notes`, { method: "POST", body: form });
  },
  retryDocuments: async (campaignId, ids, reindex = false) => {
    if (!ids.length || get().isUploading) return;
    const selected = get().documents.filter((doc) => ids.includes(doc.id)).slice(0, MAX_NOTE_FILES);
    await runBatch(campaignId, selected.map((doc) => doc.filename), `/api/campaigns/${campaignId}/notes/retry`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: selected.map((doc) => doc.id), reindex }),
    });
  },
  removeDocument: async (id) => {
    const epoch = viewEpoch;
    try {
      await api.notes.remove(id);
      if (epoch === viewEpoch) set((state) => ({ documents: state.documents.filter((doc) => doc.id !== id) }));
    } catch (error) { if (epoch === viewEpoch) set({ error: message(error, "Could not delete") }); }
  },
}));
