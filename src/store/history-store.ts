import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Dungeon } from "../engine/types.ts";
import type { DungeonConfig } from "../ai/schema.ts";

export interface HistoryEntry {
  config: DungeonConfig;
  dungeon: Dungeon;
  timestamp: number;
  label: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
  maxSize: number;

  push: (entry: HistoryEntry) => void;
  undo: () => HistoryEntry | null;
  redo: () => HistoryEntry | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      past: [],
      future: [],
      maxSize: 20,

      push: (entry) =>
        set((state) => {
          const past = [...state.past, entry];
          if (past.length > state.maxSize) {
            past.shift();
          }
          return { past, future: [] };
        }),

      undo: () => {
        const { past } = get();
        if (past.length === 0) {
          return null;
        }
        const entry = past[past.length - 1]!;
        set((state) => ({
          past: state.past.slice(0, -1),
          future: [entry, ...state.future],
        }));
        return entry;
      },

      redo: () => {
        const { future } = get();
        if (future.length === 0) {
          return null;
        }
        const entry = future[0]!;
        set((state) => ({
          past: [...state.past, entry],
          future: state.future.slice(1),
        }));
        return entry;
      },

      canUndo: () => get().past.length > 0,

      canRedo: () => get().future.length > 0,

      clear: () => set({ past: [], future: [] }),
    }),
    { name: "dungeon-slop-history" },
  ),
);
