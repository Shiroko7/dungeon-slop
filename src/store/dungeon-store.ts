import { create } from "zustand";
import type { DungeonConfig } from "../ai/schema.ts";
import type { Dungeon, Room, RoomDescription, DungeonDescription } from "../engine/types.ts";
import type { Blueprint, BlueprintProblem } from "../ai/blueprint.ts";
import { blueprintFromDungeon } from "../engine/refine-ops.ts";
import { renderDungeonDataUrl } from "../export/png-export.ts";

/** One line of a pending refinement's diff. */
export interface RefinementChange {
  summary: string;
  applied: boolean;
  note: string | null;
  reason: string | null;
}

export interface Refinement {
  critique: string;
  blueprint: Blueprint;
  changes: RefinementChange[];
  imageUsed: boolean;
}
import type { DungeonPatch, DungeonRecord } from "../campaign/types.ts";
import { useAIStore } from "./ai-store.ts";
import { api } from "./api.ts";
import { useChatStore } from "./chat-store.ts";

/**
 * The dungeon currently open in the workspace.
 *
 * This store is a working copy, not the record of truth: the database is. Edits
 * land here first so the canvas stays responsive, and a debounced autosave
 * writes them back. Nothing is persisted to localStorage any more — a second
 * copy of the geometry in the browser is a second thing that can disagree with
 * the row it came from.
 */

const SAVE_DEBOUNCE_MS = 600;

interface DungeonState {
  // Identity
  dungeonId: number | null;
  campaignId: number | null;
  name: string;

  // Content
  config: DungeonConfig | null;
  dungeon: Dungeon | null;
  /** The floor plan driving the layout, when the Architect designed one. */
  blueprint: Blueprint | null;
  blueprintProblems: BlueprintProblem[];
  /** Pending refinement, awaiting the user's accept or discard. */
  refinement: Refinement | null;
  isRefining: boolean;
  roomDescriptions: Map<number, RoomDescription>;
  dungeonDescription: DungeonDescription | null;

  // Loading/streaming
  isLoading: boolean;
  isSaving: boolean;
  isGeneratingConfig: boolean;
  isGeneratingBlueprint: boolean;
  isGeneratingDungeon: boolean;
  isDescribingRooms: boolean;
  isDescribingDungeon: boolean;
  describeProgress: { current: number; total: number; roomName: string; streamingText: string } | null;
  streamingConfig: Partial<DungeonConfig> | null;
  configRawText: string;

  error: string | null;
  clarificationQuestion: string | null;

  // Edit history — per open dungeon, cleared on load
  _undoStack: Dungeon[];
  _redoStack: Dungeon[];

  // Actions
  loadDungeon: (id: number) => Promise<void>;
  closeDungeon: () => void;
  rename: (name: string) => Promise<void>;

  setError: (error: string | null) => void;
  setConfig: (config: DungeonConfig) => void;
  setDungeon: (dungeon: Dungeon) => void;
  setRoomDescription: (roomId: number, desc: RoomDescription) => void;
  clearRoomDescription: (roomId: number) => Promise<void>;
  setDungeonDescription: (desc: DungeonDescription | null) => void;
  setStreamingConfig: (partial: Partial<DungeonConfig> | null) => void;
  setConfigRawText: (text: string) => void;
  setClarificationQuestion: (question: string | null) => void;
  setIsGeneratingConfig: (v: boolean) => void;
  setIsGeneratingDungeon: (v: boolean) => void;
  setIsDescribingRooms: (v: boolean) => void;

  setBlueprint: (blueprint: Blueprint | null) => void;
  /** Send the plan (and a render of the map) for critique. Applies nothing. */
  refineLayout: (instruction?: string) => Promise<void>;
  /** Adopt the pending refinement and rebuild the map from it. */
  acceptRefinement: () => Promise<DungeonRecord | null>;
  discardRefinement: () => void;
  /** Ask the Architect for a floor plan; does not build geometry. */
  generateBlueprint: (prompt: string) => Promise<Blueprint | null>;
  /** Returns a forked dungeon when the described original had to be preserved. */
  generateDungeonFromConfig: () => Promise<DungeonRecord | null>;
  rerollDungeon: (seed?: number) => Promise<DungeonRecord | null>;
  describeRooms: () => Promise<void>;
  describeRoom: (roomId: number) => Promise<void>;
  describeDungeon: () => Promise<void>;

  patchDungeon: (updater: (d: Dungeon) => Dungeon) => void;
  pushEditSnapshot: () => void;
  undoEdit: () => void;
  redoEdit: () => void;
  reset: () => void;
}

const transientDefaults = {
  isLoading: false,
  isSaving: false,
  isGeneratingConfig: false,
  isGeneratingBlueprint: false,
  isRefining: false,
  isGeneratingDungeon: false,
  isDescribingRooms: false,
  isDescribingDungeon: false,
  describeProgress: null as DungeonState["describeProgress"],
  streamingConfig: null as Partial<DungeonConfig> | null,
  configRawText: "",
  error: null as string | null,
  clarificationQuestion: null as string | null,
};

/**
 * Rooms per narrator call. Big enough that a 50-room map is a handful of
 * requests, small enough that one bad JSON parse doesn't cost the whole map.
 */
const DESCRIBE_BATCH_SIZE = 8;

/** SSE frames are newline-delimited. */
const NEWLINE = "\n";

// ─── autosave ─────────────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPatch: DungeonPatch = {};
let pendingId: number | null = null;

async function writePending(): Promise<void> {
  const id = pendingId;
  const patch = pendingPatch;
  pendingId = null;
  pendingPatch = {};
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (id === null || Object.keys(patch).length === 0) return;

  useDungeonStore.setState({ isSaving: true });
  try {
    await api.dungeons.update(id, patch);
  } catch (err) {
    useDungeonStore.setState({
      error: err instanceof Error ? `Could not save: ${err.message}` : "Could not save",
    });
  } finally {
    useDungeonStore.setState({ isSaving: false });
  }
}

/**
 * Coalesce writes: a drag across the canvas produces a patch per frame, and all
 * of them describe the same geometry by the time the user stops.
 */
function queueSave(id: number | null, patch: DungeonPatch): void {
  if (id === null) return;
  // Switching dungeons must never flush one map's edits onto another's row.
  if (pendingId !== null && pendingId !== id) void writePending();

  pendingId = id;
  pendingPatch = { ...pendingPatch, ...patch };
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void writePending(), SAVE_DEBOUNCE_MS);
}

/** Force any queued write out now — before navigating away, or on unload. */
export function flushDungeonSave(): Promise<void> {
  return writePending();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void writePending());
}

// ─── store ────────────────────────────────────────────────────────────────────

export const useDungeonStore = create<DungeonState>()((set, get) => ({
  dungeonId: null,
  campaignId: null,
  name: "",
  config: null,
  dungeon: null,
  blueprint: null,
  blueprintProblems: [],
  refinement: null,
  roomDescriptions: new Map<number, RoomDescription>(),
  dungeonDescription: null,
  _undoStack: [] as Dungeon[],
  _redoStack: [] as Dungeon[],
  ...transientDefaults,

  setError: (error) => set({ error }),

  loadDungeon: async (id) => {
    if (get().dungeonId === id) return;
    await writePending();

    set({ ...transientDefaults, isLoading: true, dungeonId: id });
    try {
      const record = await api.dungeons.get(id);
      set({
        dungeonId: record.id,
        campaignId: record.campaignId,
        name: record.name,
        config: record.config,
        dungeon: record.geometry,
        blueprint: record.blueprint,
        blueprintProblems: [],
        refinement: null,
        dungeonDescription: record.overview,
        roomDescriptions: new Map(record.roomNotes),
        _undoStack: [],
        _redoStack: [],
        error: null,
      });
    } catch (err) {
      set({
        dungeonId: null,
        error: err instanceof Error ? err.message : "Could not open that dungeon",
      });
    } finally {
      set({ isLoading: false });
    }
  },

  closeDungeon: () => {
    void writePending();
    set({
      dungeonId: null,
      campaignId: null,
      name: "",
      config: null,
      dungeon: null,
      dungeonDescription: null,
      roomDescriptions: new Map(),
      _undoStack: [],
      _redoStack: [],
      ...transientDefaults,
    });
  },

  rename: async (name) => {
    const { dungeonId } = get();
    if (dungeonId === null) return;
    set({ name });
    try {
      await api.dungeons.update(dungeonId, { name });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not rename" });
    }
  },

  setConfig: (config) => {
    set({ config });
    queueSave(get().dungeonId, { config, seed: config.seed ?? null });
  },

  setDungeon: (dungeon) => {
    set({ dungeon });
    queueSave(get().dungeonId, { geometry: dungeon });
  },

  setRoomDescription: (roomId, desc) => {
    set((state) => {
      const next = new Map(state.roomDescriptions);
      next.set(roomId, desc);
      return { roomDescriptions: next };
    });
    // Written straight through rather than debounced: each description is one
    // model call apart from the next, so there is nothing to coalesce.
    const { dungeonId } = get();
    if (dungeonId !== null) {
      void api.dungeons.putRoomNote(dungeonId, roomId, desc).catch((err: unknown) => {
        set({ error: err instanceof Error ? err.message : "Could not save that room" });
      });
    }
  },

  /** Drop a room's written description; the geometry is untouched. */
  clearRoomDescription: async (roomId) => {
    const { dungeonId } = get();
    set((state) => {
      const next = new Map(state.roomDescriptions);
      next.delete(roomId);
      return { roomDescriptions: next };
    });
    if (dungeonId === null) return;
    try {
      await api.dungeons.deleteRoomNote(dungeonId, roomId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not clear that room" });
    }
  },

  setDungeonDescription: (desc) => {
    set({ dungeonDescription: desc });
    queueSave(get().dungeonId, { overview: desc });
  },

  setStreamingConfig: (partial) => set({ streamingConfig: partial }),
  setConfigRawText: (text) => set({ configRawText: text }),
  setClarificationQuestion: (question) => set({ clarificationQuestion: question }),
  setIsGeneratingConfig: (v) => set({ isGeneratingConfig: v }),
  setIsGeneratingDungeon: (v) => set({ isGeneratingDungeon: v }),
  setIsDescribingRooms: (v) => set({ isDescribingRooms: v }),

  setBlueprint: (blueprint) => {
    set({ blueprint, blueprintProblems: [] });
    queueSave(get().dungeonId, { blueprint });
  },

  /*
   * Ask the Architect for the floor plan, not the geometry.
   *
   * This is the whole bet of the blueprint path: the model is asked for the one
   * thing a solver cannot do - what rooms exist, what each is for, and how they
   * connect - and never for a coordinate. Placement stays with the code that was
   * always good at it.
   */
  generateBlueprint: async (prompt: string) => {
    const ctx = aiRequestContext(get().dungeonId, get().campaignId);
    set({ isGeneratingBlueprint: true, error: null, blueprintProblems: [] });

    try {
      const res = await fetch("/api/generate-blueprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, config: get().config, ...ctx }),
      });
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let blueprint: Blueprint | null = null;
      let problems: BlueprintProblem[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(NEWLINE);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof parsed.error === "string") {
            set({ error: parsed.error });
            continue;
          }
          if (parsed.blueprint !== undefined && parsed.blueprint !== null) {
            blueprint = parsed.blueprint as Blueprint;
            problems = (parsed.problems as BlueprintProblem[]) ?? [];
          }
        }
      }

      if (blueprint !== null) {
        set({ blueprint, blueprintProblems: problems });
        queueSave(get().dungeonId, { blueprint });
      }
      return blueprint;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Floor plan generation failed" });
      return null;
    } finally {
      set({ isGeneratingBlueprint: false });
    }
  },

  discardRefinement: () => set({ refinement: null }),

  /*
   * Ask a critic what is wrong with the layout.
   *
   * Nothing is applied and nothing is saved: the response lands in
   * `refinement` for the user to read and accept. The map is rendered and sent
   * along because half the faults worth naming - long empty runs, a wing that
   * drifted into another, one room stranded in a corner - are visible in the
   * picture and invisible in the graph.
   */
  refineLayout: async (instruction?: string) => {
    const { dungeon, blueprint } = get();
    if (dungeon === null) {
      set({ error: "Generate a map before refining it" });
      return;
    }

    // A procedurally built map has no plan, but it does have roles and tiers
    // from the layout pass - enough to recover the plan it implies.
    const plan = blueprint ?? blueprintFromDungeon(dungeon);

    let image: string | null = null;
    try {
      image = await renderDungeonDataUrl(dungeon);
    } catch {
      // A render failure costs the critic its eyes, not the whole request.
      image = null;
    }

    const ctx = aiRequestContext(get().dungeonId, get().campaignId);
    const sourcePrompt = (useChatStore.getState().chat?.messages ?? [])
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n\n");

    set({ isRefining: true, error: null, refinement: null });

    try {
      const res = await fetch("/api/refine-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blueprint: plan,
          dungeon,
          image,
          sourcePrompt,
          instruction,
          ...ctx,
        }),
      });
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let refinement: Refinement | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(NEWLINE);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof parsed.error === "string") {
            set({ error: parsed.error });
            continue;
          }
          if (parsed.blueprint !== undefined && parsed.blueprint !== null) {
            refinement = {
              critique: String(parsed.critique ?? ""),
              blueprint: parsed.blueprint as Blueprint,
              changes: (parsed.changes as RefinementChange[]) ?? [],
              imageUsed: parsed.imageUsed === true,
            };
          }
        }
      }

      set({ refinement });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Refinement failed" });
    } finally {
      set({ isRefining: false });
    }
  },

  acceptRefinement: async () => {
    const { refinement, config } = get();
    if (refinement === null || config === null) return null;

    set({ blueprint: refinement.blueprint, blueprintProblems: [], refinement: null });
    queueSave(get().dungeonId, { blueprint: refinement.blueprint });

    // A refined plan is a different dungeon, so it gets a fresh seed rather
    // than reusing one whose placement was solved for the old room set.
    return applyGeneratedGeometry(
      { ...config, seed: Math.floor(Math.random() * 2147483647) },
      set,
      get,
    );
  },

  generateDungeonFromConfig: async () => {
    const { config } = get();
    if (config === null) return null;
    const record = await applyGeneratedGeometry(config, set, get);

    // A fork hands the caller a different dungeon and navigates away from this
    // one, so describing the copy the store still holds would bill for text
    // nobody ever sees. Only chain when the geometry landed in place.
    if (record === null && useAIStore.getState().autoDescribe && get().dungeon !== null) {
      await get().describeRooms();
      await get().describeDungeon();
    }
    return record;
  },

  /**
   * A reroll never overwrites a described map. New geometry means new room ids,
   * so writing over the original would silently invalidate every description
   * already written against it — instead the reroll lands as a sibling.
   */
  rerollDungeon: async (seed?: number) => {
    const { config } = get();
    if (config === null) return null;
    const newSeed = seed ?? Math.floor(Math.random() * 2147483647);
    return applyGeneratedGeometry({ ...config, seed: newSeed }, set, get);
  },

  /*
   * Rooms are described in batches, not one request per room.
   *
   * The per-room loop this replaces cost one model call per room, which was
   * tolerable at six rooms and ruinous once the density fix started producing
   * fifty. Batching also reads better: the model sees a group at once, so it
   * varies them against each other instead of writing each in isolation.
   */
  describeRooms: async () => {
    const { dungeon, config } = get();
    if (!dungeon || !config) return;
    const ctx = aiRequestContext(get().dungeonId, get().campaignId);
    const rooms = dungeon.rooms;
    const total = rooms.length;

    const batches: Room[][] = [];
    for (let i = 0; i < rooms.length; i += DESCRIBE_BATCH_SIZE) {
      batches.push(rooms.slice(i, i + DESCRIBE_BATCH_SIZE));
    }

    set({
      isDescribingRooms: true,
      error: null,
      describeProgress: { current: 0, total, roomName: "", streamingText: "" },
    });

    let done = 0;
    for (const batch of batches) {
      const label = batch.length === 1
        ? `Room ${batch[0]!.id}`
        : `Rooms ${batch[0]!.id}-${batch[batch.length - 1]!.id}`;
      set({ describeProgress: { current: done + 1, total, roomName: label, streamingText: "" } });

      try {
        const res = await fetch("/api/describe-rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rooms: batch,
            allRooms: dungeon.rooms,
            corridors: dungeon.corridors,
            config,
            ...ctx,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          set({ error: `Failed on ${label}: ${body}` });
          done += batch.length;
          continue;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          done += batch.length;
          continue;
        }
        const decoder = new TextDecoder();
        let buffer = "";
        let streamingText = "";
        while (true) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
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
              set({ error: `AI error on ${label}: ${String(parsed.error)}` });
              continue;
            }
            if (typeof parsed.text === "string") {
              streamingText += parsed.text;
              set({ describeProgress: { current: done + 1, total, roomName: label, streamingText } });
            }
            if (Array.isArray(parsed.descriptions)) {
              // Positional: the narrator answers one object per input room, in
              // order. Zipping by index is what the endpoint contract promises.
              const descriptions = parsed.descriptions as RoomDescription[];
              batch.forEach((room, i) => {
                const description = descriptions[i];
                if (description !== undefined) get().setRoomDescription(room.id, description);
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Room description failed";
        set({ error: `${label}: ${msg}` });
      }
      done += batch.length;
      set({ describeProgress: { current: Math.min(done, total), total, roomName: label, streamingText: "" } });
    }

    set({ isDescribingRooms: false, describeProgress: null });
  },

  describeRoom: async (roomId: number) => {
    const { dungeon, config } = get();
    if (!dungeon || !config) return;
    const room = dungeon.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const ctx = aiRequestContext(get().dungeonId, get().campaignId);
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
          ...ctx,
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
      set({ error: err instanceof Error ? err.message : "Room description failed" });
    }
  },

  describeDungeon: async () => {
    const { dungeon, config } = get();
    if (!dungeon || !config) return;
    const ctx = aiRequestContext(get().dungeonId, get().campaignId);
    set({ isDescribingDungeon: true, error: null });
    try {
      const res = await fetch("/api/describe-dungeon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rooms: dungeon.rooms,
          corridors: dungeon.corridors,
          config,
          ...ctx,
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
            get().setDungeonDescription(parsed.description as DungeonDescription);
          }
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Dungeon description failed" });
    } finally {
      set({ isDescribingDungeon: false });
    }
  },

  patchDungeon: (updater) => {
    const { dungeon, dungeonId } = get();
    if (!dungeon) return;
    const next = updater(dungeon);
    set({ dungeon: next });
    queueSave(dungeonId, { geometry: next });
  },

  pushEditSnapshot: () => {
    const { dungeon, _undoStack } = get();
    if (!dungeon) return;
    const next = [..._undoStack, dungeon];
    if (next.length > 50) next.shift();
    set({ _undoStack: next, _redoStack: [] });
  },

  undoEdit: () => {
    const { dungeon, dungeonId, _undoStack, _redoStack } = get();
    if (_undoStack.length === 0 || !dungeon) return;
    const prev = _undoStack[_undoStack.length - 1]!;
    const nextRedo = [dungeon, ..._redoStack].slice(0, 50);
    set({ dungeon: prev, _undoStack: _undoStack.slice(0, -1), _redoStack: nextRedo });
    queueSave(dungeonId, { geometry: prev });
  },

  redoEdit: () => {
    const { dungeon, dungeonId, _undoStack, _redoStack } = get();
    if (_redoStack.length === 0 || !dungeon) return;
    const next = _redoStack[0]!;
    const nextUndo = [..._undoStack, dungeon].slice(-50);
    set({ dungeon: next, _undoStack: nextUndo, _redoStack: _redoStack.slice(1) });
    queueSave(dungeonId, { geometry: next });
  },

  reset: () =>
    set({
      config: null,
      dungeon: null,
      roomDescriptions: new Map<number, RoomDescription>(),
      dungeonDescription: null,
      _undoStack: [],
      _redoStack: [],
      ...transientDefaults,
    }),
}));

/**
 * Build geometry from a config and put it somewhere safe.
 *
 * If nothing has been described yet the new map replaces the old one in place —
 * there is nothing to lose. Once room descriptions exist, the result lands as a
 * fork instead, and the caller navigates to it. This is the single rule behind
 * both Generate and Reroll, so neither can quietly destroy written material.
 */
/**
 * Every AI request carries the same three things: which model to use, who to
 * bill it to, and what the user actually asked for.
 *
 * The source material matters most. The Architect turns "icecrown citadel from
 * wotlk" into a config whose theme_description paraphrases it into atmosphere
 * and drops the proper nouns, so without the original chat the Narrator has no
 * way to know it should be writing Lady Deathwhisper rather than a frozen hall.
 */
function aiRequestContext(dungeonId: number | null, campaignId: number | null) {
  const { temperature, provider, model, thinkingLevel, captureReasoning } =
    useAIStore.getState();
  const chat = useChatStore.getState().chat;

  return {
    temperature,
    provider,
    model,
    thinkingLevel,
    includeThoughts: captureReasoning,
    campaignId,
    dungeonId,
    chatId: chat?.id ?? null,
    conversationHistory: (chat?.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  };
}

async function applyGeneratedGeometry(
  config: DungeonConfig,
  set: (partial: Partial<DungeonState>) => void,
  get: () => DungeonState,
): Promise<DungeonRecord | null> {
  const { dungeonId, roomDescriptions, blueprint } = get();
  set({ isGeneratingDungeon: true, error: null });

  try {
    const res = await fetch("/api/generate-dungeon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, blueprint }),
    });
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
    const data = (await res.json()) as { dungeon: Dungeon };

    if (dungeonId !== null && roomDescriptions.size > 0) {
      await writePending();
      return await api.dungeons.fork(dungeonId, {
        seed: config.seed ?? null,
        config,
        geometry: data.dungeon,
        blueprint,
      });
    }

    set({
      config,
      dungeon: data.dungeon,
      roomDescriptions: new Map(),
      dungeonDescription: null,
      _undoStack: [],
      _redoStack: [],
    });
    queueSave(dungeonId, {
      config,
      seed: config.seed ?? null,
      geometry: data.dungeon,
      overview: null,
      blueprint,
    });
    return null;
  } catch (err) {
    set({ error: err instanceof Error ? err.message : "Dungeon generation failed" });
    return null;
  } finally {
    set({ isGeneratingDungeon: false });
  }
}
