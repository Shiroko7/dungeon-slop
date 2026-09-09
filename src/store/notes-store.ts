import { create } from "zustand";
import { api } from "./api.ts";
import type { NoteDocument } from "../notes/types.ts";

export interface UploadEntry {
  filename: string;
  status: "pending" | "indexed" | "failed";
  chunks?: number;
  error?: string;
}

interface NotesState {
  /** Which campaign's library is loaded — everything below belongs to it. */
  campaignId: number | null;
  documents: NoteDocument[];
  isLoading: boolean;
  isUploading: boolean;
  /** Per-file outcomes for the run in progress; cleared when the next one starts. */
  uploadLog: UploadEntry[];
  /** Non-null while the summary backfill runs after a deferred bulk upload. */
  summaryProgress: { completed: number; total: number } | null;
  error: string | null;

  fetchDocuments: (campaignId: number) => Promise<void>;
  uploadFiles: (campaignId: number, files: File[]) => Promise<void>;
  removeDocument: (id: number) => Promise<void>;
  setError: (error: string | null) => void;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export const useNotesStore = create<NotesState>()((set, get) => ({
  campaignId: null,
  documents: [],
  isLoading: false,
  isUploading: false,
  uploadLog: [],
  summaryProgress: null,
  error: null,

  setError: (error) => set({ error }),

  fetchDocuments: async (campaignId) => {
    // Drop the previous campaign's list immediately. Showing one campaign's
    // notes under another's name, even for a frame, is worse than showing none.
    if (get().campaignId !== campaignId) {
      set({ campaignId, documents: [], uploadLog: [] });
    }
    set({ isLoading: true });
    try {
      set({ documents: await api.notes.list(campaignId), error: null });
    } catch (err) {
      set({ error: message(err, "Could not load notes") });
    } finally {
      set({ isLoading: false });
    }
  },

  uploadFiles: async (campaignId, files) => {
    if (files.length === 0 || get().isUploading) return;

    set({
      campaignId,
      isUploading: true,
      error: null,
      summaryProgress: null,
      uploadLog: files.map((f) => ({ filename: f.name, status: "pending" as const })),
    });

    const form = new FormData();
    for (const file of files) form.append("files", file);

    try {
      const response = await fetch(`/api/campaigns/${campaignId}/notes`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Server responded with ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }

          switch (event["type"]) {
            case "file": {
              const index = event["index"] as number;
              set((state) => {
                const log = [...state.uploadLog];
                const existing = log[index];
                if (existing !== undefined) {
                  log[index] = {
                    ...existing,
                    status: event["status"] === "indexed" ? "indexed" : "failed",
                    chunks: event["chunks"] as number | undefined,
                    error: event["error"] as string | undefined,
                  };
                }
                return { uploadLog: log };
              });
              break;
            }
            case "summary_progress":
              set({
                summaryProgress: {
                  completed: event["completed"] as number,
                  total: event["total"] as number,
                },
              });
              break;
            case "summarized":
              set({ summaryProgress: null });
              break;
            case "error":
              set({ error: (event["error"] as string) ?? "Upload failed" });
              break;
          }
        }
      }
    } catch (err) {
      set({ error: message(err, "Upload failed") });
    } finally {
      set({ isUploading: false, summaryProgress: null });
      // Refresh regardless: a run that failed partway still indexed whatever
      // it got through, and the list should show that rather than go stale.
      await get().fetchDocuments(campaignId);
    }
  },

  removeDocument: async (id) => {
    try {
      await api.notes.remove(id);
      set((state) => ({ documents: state.documents.filter((d) => d.id !== id) }));
    } catch (err) {
      set({ error: message(err, "Could not delete") });
    }
  },
}));
