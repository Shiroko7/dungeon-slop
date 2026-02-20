import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DungeonConfig } from "../ai/schema.ts";
import type { Dungeon, RoomDescription, DungeonDescription } from "../engine/types.ts";
import { useAIStore } from "./ai-store.ts";
import { useHistoryStore } from "./history-store.ts";
import type { HistoryEntry } from "./history-store.ts";

/** Shape stored in localStorage (Map converted to array of entries) */
interface PersistedDungeonState {
  config: DungeonConfig | null;
  dungeon: Dungeon | null;
  roomDescriptions: Array<[number, RoomDescription]>;
  dungeonDescription: DungeonDescription | null;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

interface DungeonState {
  // State
  config: DungeonConfig | null;
  dungeon: Dungeon | null;
  roomDescriptions: Map<number, RoomDescription>;
  dungeonDescription: DungeonDescription | null;

  // Loading/streaming
  isGeneratingConfig: boolean;
  isGeneratingDungeon: boolean;
  isDescribingRooms: boolean;
  isDescribingDungeon: boolean;
  describeProgress: { current: number; total: number; roomName: string; streamingText: string } | null;
  streamingConfig: Partial<DungeonConfig> | null;
  configRawText: string;

  // Errors
  error: string | null;

  // Conversation
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  clarificationQuestion: string | null;

  // Edit history (not persisted)
  _undoStack: Dungeon[];
  _redoStack: Dungeon[];

  // Actions
  setError: (error: string | null) => void;
  setConfig: (config: DungeonConfig) => void;
  setDungeon: (dungeon: Dungeon) => void;
  setRoomDescription: (roomId: number, desc: RoomDescription) => void;
  setDungeonDescription: (desc: DungeonDescription | null) => void;
  setStreamingConfig: (partial: Partial<DungeonConfig> | null) => void;
  setConfigRawText: (text: string) => void;
  setClarificationQuestion: (question: string | null) => void;
  addConversationMessage: (
    role: "user" | "assistant",
    content: string,
  ) => void;
  clearConversation: () => void;
  setIsGeneratingConfig: (v: boolean) => void;
  setIsGeneratingDungeon: (v: boolean) => void;
  setIsDescribingRooms: (v: boolean) => void;
  generateDungeonFromConfig: () => Promise<void>;
  rerollDungeon: (seed?: number) => Promise<void>;
  describeRooms: () => Promise<void>;
  describeRoom: (roomId: number) => Promise<void>;
  describeDungeon: () => Promise<void>;
  truncateConversationTo: (index: number) => void;
  restoreSession: (entry: HistoryEntry) => void;
  patchDungeon: (updater: (d: Dungeon) => Dungeon) => void;
  pushEditSnapshot: () => void;
  undoEdit: () => void;
  redoEdit: () => void;
  reset: () => void;
}

const transientDefaults = {
  isGeneratingConfig: false,
  isGeneratingDungeon: false,
  isDescribingRooms: false,
  isDescribingDungeon: false,
  describeProgress: null as DungeonState["describeProgress"],
  streamingConfig: null as Partial<DungeonConfig> | null,
  configRawText: "",
  error: null as string | null,
  clarificationQuestion: null as string | null,
};

export const useDungeonStore = create<DungeonState>()(
  persist(
    (set, get) => ({
      config: null,
      dungeon: null,
      roomDescriptions: new Map<number, RoomDescription>(),
      dungeonDescription: null,
      conversationHistory: [],
      _undoStack: [] as Dungeon[],
      _redoStack: [] as Dungeon[],
      ...transientDefaults,

      setError: (error) => set({ error }),

      setConfig: (config) => set({ config }),

      setDungeon: (dungeon) => set({ dungeon }),

      setRoomDescription: (roomId, desc) =>
        set((state) => {
          const next = new Map(state.roomDescriptions);
          next.set(roomId, desc);
          return { roomDescriptions: next };
        }),

      setDungeonDescription: (desc) => set({ dungeonDescription: desc }),

      setStreamingConfig: (partial) => set({ streamingConfig: partial }),

      setConfigRawText: (text) => set({ configRawText: text }),

      setClarificationQuestion: (question) =>
        set({ clarificationQuestion: question }),

      addConversationMessage: (role, content) =>
        set((state) => ({
          conversationHistory: [...state.conversationHistory, { role, content }],
        })),

      clearConversation: () =>
        set({ conversationHistory: [], clarificationQuestion: null }),

      truncateConversationTo: (index) =>
        set((state) => ({ conversationHistory: state.conversationHistory.slice(0, index) })),

      restoreSession: (entry) =>
        set({
          config: entry.config,
          dungeon: entry.dungeon,
          roomDescriptions: new Map(),
          dungeonDescription: null,
          conversationHistory: [...entry.conversationHistory],
          clarificationQuestion: null,
          error: null,
        }),

      patchDungeon: (updater) => {
        const { dungeon } = get();
        if (!dungeon) return;
        set({ dungeon: updater(dungeon) });
      },

      pushEditSnapshot: () => {
        const { dungeon, _undoStack } = get();
        if (!dungeon) return;
        const next = [..._undoStack, dungeon];
        if (next.length > 50) next.shift();
        set({ _undoStack: next, _redoStack: [] });
      },

      undoEdit: () => {
        const { dungeon, _undoStack, _redoStack } = get();
        if (_undoStack.length === 0 || !dungeon) return;
        const prev = _undoStack[_undoStack.length - 1]!;
        const nextRedo = [dungeon, ..._redoStack].slice(0, 50);
        set({ dungeon: prev, _undoStack: _undoStack.slice(0, -1), _redoStack: nextRedo });
      },

      redoEdit: () => {
        const { dungeon, _undoStack, _redoStack } = get();
        if (_redoStack.length === 0 || !dungeon) return;
        const next = _redoStack[0]!;
        const nextUndo = [..._undoStack, dungeon].slice(-50);
        set({ dungeon: next, _undoStack: nextUndo, _redoStack: _redoStack.slice(1) });
      },

      setIsGeneratingConfig: (v) => set({ isGeneratingConfig: v }),

      setIsGeneratingDungeon: (v) => set({ isGeneratingDungeon: v }),

      setIsDescribingRooms: (v) => set({ isDescribingRooms: v }),

      generateDungeonFromConfig: async () => {
        const { config } = get();
        if (!config) return;
        set({ isGeneratingDungeon: true });
        try {
          const res = await fetch("/api/generate-dungeon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
          });
          if (!res.ok) throw new Error(`Server responded with ${res.status}`);
          const data = (await res.json()) as { dungeon: Dungeon };
          set({ dungeon: data.dungeon, roomDescriptions: new Map(), dungeonDescription: null });
          // Push a snapshot to session history
          const { conversationHistory } = get();
          const firstUserMsg = conversationHistory.find((m) => m.role === "user")?.content ?? "";
          const label = firstUserMsg.length > 44
            ? firstUserMsg.slice(0, 44) + "…"
            : firstUserMsg || config.motif + " dungeon";
          useHistoryStore.getState().push({
            config,
            dungeon: data.dungeon,
            timestamp: Date.now(),
            label,
            conversationHistory: conversationHistory.map((m) => ({ ...m })),
          });
        } catch (err) {
          console.error("Dungeon generation failed:", err);
        } finally {
          set({ isGeneratingDungeon: false });
        }
      },

      rerollDungeon: async (seed?: number) => {
        const { config } = get();
        if (!config) return;
        const newSeed = seed ?? Math.floor(Math.random() * 2147483647);
        const newConfig = { ...config, seed: newSeed };
        set({ config: newConfig, isGeneratingDungeon: true });
        try {
          const res = await fetch("/api/generate-dungeon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newConfig),
          });
          if (!res.ok) throw new Error(`Server responded with ${res.status}`);
          const data = (await res.json()) as { dungeon: Dungeon };
          set({ dungeon: data.dungeon, roomDescriptions: new Map(), dungeonDescription: null });
          const { conversationHistory } = get();
          const firstUserMsg = conversationHistory.find((m) => m.role === "user")?.content ?? "";
          const label = (firstUserMsg.length > 44 ? firstUserMsg.slice(0, 44) + "…" : firstUserMsg) || newConfig.motif + " dungeon";
          useHistoryStore.getState().push({
            config: newConfig,
            dungeon: data.dungeon,
            timestamp: Date.now(),
            label: label + " (reroll)",
            conversationHistory: conversationHistory.map((m) => ({ ...m })),
          });
        } catch (err) {
          console.error("Dungeon reroll failed:", err);
        } finally {
          set({ isGeneratingDungeon: false });
        }
      },

      describeRooms: async () => {
        const { dungeon, config } = get();
        if (!dungeon || !config) return;
        const { temperature, provider } = useAIStore.getState();
        const rooms = dungeon.rooms;
        const total = rooms.length;

        set({ isDescribingRooms: true, error: null, describeProgress: { current: 0, total, roomName: "", streamingText: "" } });

        for (let i = 0; i < rooms.length; i++) {
          const room = rooms[i]!;
          const roomName = `Room ${room.id}`;
          set({ describeProgress: { current: i + 1, total, roomName, streamingText: "" } });

          try {
            const res = await fetch(`/api/describe-room/${room.id}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                room,
                allRooms: dungeon.rooms,
                corridors: dungeon.corridors,
                config,
                temperature,
                provider,
              }),
            });
            if (!res.ok) {
              const body = await res.text();
              set({ error: `Failed on ${roomName}: ${body}` });
              continue;
            }
            const reader = res.body?.getReader();
            if (!reader) continue;
            const decoder = new TextDecoder();
            let buffer = "";
            let streamingText = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                let parsed: Record<string, unknown>;
                try {
                  parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
                } catch {
                  continue;
                }
                if (parsed.error) {
                  set({ error: `AI error on ${roomName}: ${parsed.error}` });
                  continue;
                }
                if (parsed.text && typeof parsed.text === "string") {
                  streamingText += parsed.text;
                  set({ describeProgress: { current: i + 1, total, roomName, streamingText } });
                }
                if (parsed.description) {
                  get().setRoomDescription(room.id, parsed.description as RoomDescription);
                }
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Room description failed";
            set({ error: `${roomName}: ${msg}` });
          }
        }

        set({ isDescribingRooms: false, describeProgress: null });
      },

      describeRoom: async (roomId: number) => {
        const { dungeon, config } = get();
        if (!dungeon || !config) return;
        const room = dungeon.rooms.find((r) => r.id === roomId);
        if (!room) return;
        const { temperature } = useAIStore.getState();
        set({ error: null });
        try {
          const res = await fetch(`/api/describe-room/${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              room,
              allRooms: dungeon.rooms,
              corridors: dungeon.corridors,
              config,
              temperature,
              provider: useAIStore.getState().provider,
            }),
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`Server error ${res.status}: ${body}`);
          }
          const reader = res.body?.getReader();
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
              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
              } catch {
                continue;
              }
              if (parsed.error) {
                set({ error: `AI error: ${parsed.error}` });
                continue;
              }
              if (parsed.description) {
                get().setRoomDescription(roomId, parsed.description as RoomDescription);
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Room description failed";
          set({ error: msg });
        }
      },

      describeDungeon: async () => {
        const { dungeon, config } = get();
        if (!dungeon || !config) return;
        const { temperature, provider } = useAIStore.getState();
        set({ isDescribingDungeon: true, error: null });
        try {
          const res = await fetch("/api/describe-dungeon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              rooms: dungeon.rooms,
              corridors: dungeon.corridors,
              config,
              temperature,
              provider,
            }),
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`Server error ${res.status}: ${body}`);
          }
          const reader = res.body?.getReader();
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
              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
              } catch {
                continue;
              }
              if (parsed.error) {
                set({ error: `AI error: ${parsed.error}` });
                continue;
              }
              if (parsed.description) {
                set({ dungeonDescription: parsed.description as DungeonDescription });
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Dungeon description failed";
          set({ error: msg });
        } finally {
          set({ isDescribingDungeon: false });
        }
      },

      reset: () =>
        set({
          config: null,
          dungeon: null,
          roomDescriptions: new Map<number, RoomDescription>(),
          dungeonDescription: null,
          conversationHistory: [],
          _undoStack: [],
          _redoStack: [],
          ...transientDefaults,
        }),
    }),
    {
      name: "dungeon-slop-dungeon",
      partialize: (state) => ({
        config: state.config,
        dungeon: state.dungeon,
        roomDescriptions: Array.from(state.roomDescriptions.entries()),
        dungeonDescription: state.dungeonDescription,
        conversationHistory: state.conversationHistory,
      }),
      merge: (persisted, currentState) => {
        const stored = persisted as Partial<PersistedDungeonState> | undefined;
        if (!stored) return currentState;
        return {
          ...currentState,
          config: stored.config ?? null,
          dungeon: stored.dungeon ?? null,
          roomDescriptions: new Map(stored.roomDescriptions ?? []),
          dungeonDescription: stored.dungeonDescription ?? null,
          conversationHistory: stored.conversationHistory ?? [],
        };
      },
    },
  ),
);
