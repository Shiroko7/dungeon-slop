import { create } from "zustand";
import { api } from "./api.ts";
import type { NoteSearchInput, NoteSearchResult } from "../notes/retrieval-types.ts";

interface SearchState {
  campaignId: number | null;
  input: NoteSearchInput;
  result: NoteSearchResult | null;
  error: string | null;
  busy: boolean;
  open: (campaignId: number) => void;
  change: (patch: Partial<NoteSearchInput>) => void;
  search: () => Promise<void>;
  cancel: () => void;
  close: () => void;
}
const defaults = (): NoteSearchInput => ({ query: "", mode: "lexical", limit: 5, tokenBudget: 3000, neighbors: 1 });
let epoch = 0;
let controller: AbortController | null = null;
function interrupt() { ++epoch; controller?.abort(); controller = null; }

export const useNoteSearchStore = create<SearchState>()((set, get) => ({
  campaignId: null, input: defaults(), result: null, error: null, busy: false,
  open: (campaignId) => {
    if (get().campaignId === campaignId) return;
    interrupt();
    set({ campaignId, input: defaults(), result: null, error: null, busy: false });
  },
  change: (patch) => {
    interrupt();
    set((state) => ({ input: { ...state.input, ...patch }, result: null, error: null, busy: false }));
  },
  cancel: () => { interrupt(); set({ busy: false, error: "Search cancelled. No notes were changed." }); },
  close: () => { interrupt(); set({ campaignId: null, input: defaults(), result: null, error: null, busy: false }); },
  search: async () => {
    const { campaignId, input } = get();
    if (campaignId === null) return;
    interrupt();
    const ticket = epoch;
    const abort = new AbortController();
    controller = abort;
    set({ busy: true, error: null, result: null });
    try {
      const result = await api.notes.search(campaignId, input, AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]));
      if (ticket === epoch) set({ result });
    } catch (error) {
      if (ticket === epoch) set({ error: error instanceof Error ? error.message : "Could not search notes" });
    } finally {
      if (ticket === epoch) { controller = null; set({ busy: false }); }
    }
  },
}));
