import { create } from "zustand";
import { dungeonSaves } from "./dungeon-saves.ts";
import { OperationScope, events, type Operation } from "./operation.ts";
import { parseRoute, subscribeNavigation } from "../router/router.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import type {
  Dungeon,
  RoomDescription,
  DungeonDescription,
} from "../engine/types.ts";
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
import { useChatStore, chatVersion } from "./chat-store.ts";

/**
 * The dungeon currently open in the workspace.
 *
 * This store is a working copy, not the record of truth: the database is. Edits
 * land here first so the canvas stays responsive, and a debounced autosave
 * writes them back through a revision-checked outbox. Only unacknowledged
 * operations are retained locally for recovery; SQLite remains canonical.
 */

let loadEpoch = 0;
let applyingOperation = false;

interface DungeonState {
  // Identity
  dungeonId: number | null;
  campaignId: number | null;
  name: string;

  // Content
  config: DungeonConfig | null;
  /** AI output that has not been applied to a map yet. */
  proposedConfig: DungeonConfig | null;
  dungeon: Dungeon | null;
  /** The floor plan driving the layout, when the Architect designed one. */
  blueprint: Blueprint | null;
  proposedBlueprint: Blueprint | null;
  blueprintProblems: BlueprintProblem[];
  /** Pending refinement, awaiting the user's accept or discard. */
  refinement: Refinement | null;
  isRefining: boolean;
  roomDescriptions: Map<number, RoomDescription>;
  dungeonDescription: DungeonDescription | null;
  missingRoomIds: number[];
  pendingForkOperationId: string | null;

  // Loading/streaming
  isLoading: boolean;
  isGeneratingConfig: boolean;
  isGeneratingBlueprint: boolean;
  isGeneratingDungeon: boolean;
  isDescribingRooms: boolean;
  isDescribingDungeon: boolean;
  describeProgress: {
    current: number;
    total: number;
    roomName: string;
    streamingText: string;
  } | null;
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
  setProposedConfig: (config: DungeonConfig | null) => void;
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
  setProposedBlueprint: (blueprint: Blueprint | null) => void;
  /** Send the plan (and a render of the map) for critique. Applies nothing. */
  refineLayout: (instruction?: string) => Promise<void>;
  /** Adopt the pending refinement and rebuild the map from it. */
  acceptRefinement: () => Promise<DungeonRecord | null>;
  discardRefinement: () => void;
  /** Ask the Architect for a floor plan; does not build geometry. */
  generateBlueprint: (
    prompt: string,
    operation?: DungeonOperation,
  ) => Promise<Blueprint | null>;
  /** Returns a forked dungeon when the described original had to be preserved. */
  generateDungeonFromConfig: () => Promise<DungeonRecord | null>;
  rerollDungeon: (seed?: number) => Promise<DungeonRecord | null>;
  restoreRevision: (revisionId: number) => Promise<boolean>;
  describeRooms: (roomIds?: number[]) => Promise<boolean>;
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

// ─── autosave ─────────────────────────────────────────────────────────────────

export const dungeonOperations = new OperationScope(() => {
  useDungeonStore.setState({
    isGeneratingConfig: false,
    isGeneratingBlueprint: false,
    isGeneratingDungeon: false,
    isDescribingRooms: false,
    isDescribingDungeon: false,
    isRefining: false,
    describeProgress: null,
  });
});
export interface DungeonOperation extends Operation {
  dungeonId: number | null;
  campaignId: number | null;
  chatId: number | null;
  commit(fn: () => void): void;
}
export function beginDungeonOperation(): DungeonOperation {
  const state = useDungeonStore.getState();
  const chat = useChatStore.getState().chat;
  const epoch = loadEpoch;
  const transcriptVersion = chatVersion();
  const base = dungeonOperations.begin();
  const valid = () =>
    base.valid() &&
    epoch === loadEpoch &&
    chatVersion() === transcriptVersion &&
    useDungeonStore.getState().dungeonId === state.dungeonId;
  const operation: DungeonOperation = {
    ...base,
    dungeonId: state.dungeonId,
    campaignId: state.campaignId,
    chatId:
      chat?.dungeonId === state.dungeonId &&
      chat?.campaignId === state.campaignId
        ? chat.id
        : null,
    valid,
    assert: () => {
      if (!valid()) throw new DOMException("Operation cancelled", "AbortError");
    },
    commit: (fn) => {
      operation.assert();
      applyingOperation = true;
      try {
        fn();
      } finally {
        applyingOperation = false;
      }
    },
  };
  return operation;
}
function queueSave(id: number | null, patch: DungeonPatch): void {
  if (!applyingOperation) dungeonOperations.cancel();
  if (id === null) return;
  const state = useDungeonStore.getState();
  if (state.dungeonId !== id || state.campaignId === null)
    throw new Error("Save owner mismatch");
  dungeonSaves.queue(
    { id, campaignId: state.campaignId, name: state.name },
    patch,
  );
}
export async function flushDungeonSave(): Promise<void> {
  await Promise.all(
    dungeonSaves
      .pendingEntries()
      .map((entry) => dungeonSaves.flush(entry.dungeonId)),
  );
}
const writePending = flushDungeonSave;
export async function prepareAI(operation: DungeonOperation) {
  operation.assert();
  if (operation.dungeonId !== null) {
    await dungeonSaves.flush(operation.dungeonId);
    operation.assert();
    if (dungeonSaves.state(operation.dungeonId).status !== "saved")
      throw new Error("Resolve the pending save before generating.");
  }
  return {
    ...aiRequestContext(operation.dungeonId, operation.campaignId),
    operationId: operation.id,
    chatId: operation.chatId,
    expectedRevision:
      operation.dungeonId === null
        ? undefined
        : dungeonSaves.revision(operation.dungeonId),
  };
}
function operationError(operation: Operation, err: unknown) {
  if (operation.valid())
    useDungeonStore.setState({
      error: err instanceof Error ? err.message : "Request failed",
    });
}

// ─── store ────────────────────────────────────────────────────────────────────

export const useDungeonStore = create<DungeonState>()((set, get) => ({
  dungeonId: null,
  campaignId: null,
  name: "",
  config: null,
  proposedConfig: null,
  dungeon: null,
  blueprint: null,
  proposedBlueprint: null,
  blueprintProblems: [],
  refinement: null,
  roomDescriptions: new Map<number, RoomDescription>(),
  dungeonDescription: null,
  missingRoomIds: [],
  pendingForkOperationId: null,
  _undoStack: [] as Dungeon[],
  _redoStack: [] as Dungeon[],
  ...transientDefaults,

  setError: (error) => set({ error }),

  loadDungeon: async (id) => {
    if (get().dungeonId === id && !get().error) return;
    const epoch = ++loadEpoch;
    dungeonOperations.cancel();
    void writePending();
    set({
      ...transientDefaults,
      isLoading: true,
      dungeonId: id,
      campaignId: null,
      name: "",
      config: null,
      proposedConfig: null,
      dungeon: null,
      blueprint: null,
      proposedBlueprint: null,
      refinement: null,
      blueprintProblems: [],
      roomDescriptions: new Map(),
      dungeonDescription: null,
      missingRoomIds: [],
      pendingForkOperationId: null,
      _undoStack: [],
      _redoStack: [],
    });
    try {
      const loaded = await api.dungeons.get(id);
      if (epoch !== loadEpoch) return;
      const record = dungeonSaves.attach(loaded);
      set({
        dungeonId: record.id,
        campaignId: record.campaignId,
        name: record.name,
        config: record.config,
        proposedConfig: null,
        dungeon: record.geometry,
        blueprint: record.blueprint,
        proposedBlueprint: null,
        dungeonDescription: record.overview,
        roomDescriptions: new Map(record.roomNotes),
        missingRoomIds: [],
        pendingForkOperationId: null,
        error: null,
      });
    } catch (err) {
      if (epoch === loadEpoch)
        set({
          error:
            err instanceof Error ? err.message : "Could not open that dungeon",
        });
    } finally {
      if (epoch === loadEpoch) set({ isLoading: false });
    }
  },

  closeDungeon: () => {
    ++loadEpoch;
    dungeonOperations.cancel();
    void writePending();
    set({
      dungeonId: null,
      campaignId: null,
      name: "",
      config: null,
      proposedConfig: null,
      dungeon: null,
      blueprint: null,
      proposedBlueprint: null,
      blueprintProblems: [],
      refinement: null,
      dungeonDescription: null,
      roomDescriptions: new Map(),
      missingRoomIds: [],
      pendingForkOperationId: null,
      _undoStack: [],
      _redoStack: [],
      ...transientDefaults,
    });
  },

  rename: async (name) => {
    if (get().dungeonId === null || !name.trim()) return;
    set({ name });
    queueSave(get().dungeonId, { name });
  },

  setConfig: (config) => {
    set({ config });
    queueSave(get().dungeonId, { config, seed: config.seed ?? null });
  },

  setProposedConfig: (proposedConfig) => {
    if (!applyingOperation) dungeonOperations.cancel();
    set({ proposedConfig });
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
    queueSave(get().dungeonId, { roomNotes: [[roomId, desc]] });
  },

  clearRoomDescription: async (roomId) => {
    set((state) => {
      const next = new Map(state.roomDescriptions);
      next.delete(roomId);
      return { roomDescriptions: next };
    });
    queueSave(get().dungeonId, { roomNotes: [[roomId, null]] });
  },

  setDungeonDescription: (desc) => {
    set({ dungeonDescription: desc });
    queueSave(get().dungeonId, { overview: desc });
  },

  setStreamingConfig: (partial) => set({ streamingConfig: partial }),
  setConfigRawText: (text) => set({ configRawText: text }),
  setClarificationQuestion: (question) =>
    set({ clarificationQuestion: question }),
  setIsGeneratingConfig: (v) => set({ isGeneratingConfig: v }),
  setIsGeneratingDungeon: (v) => set({ isGeneratingDungeon: v }),
  setIsDescribingRooms: (v) => set({ isDescribingRooms: v }),

  setBlueprint: (blueprint) => {
    set({ blueprint, blueprintProblems: [] });
    queueSave(get().dungeonId, { blueprint });
  },

  setProposedBlueprint: (proposedBlueprint) => {
    if (!applyingOperation) dungeonOperations.cancel();
    set({ proposedBlueprint, blueprintProblems: [] });
  },

  /*
   * Ask the Architect for the floor plan, not the geometry.
   *
   * This is the whole bet of the blueprint path: the model is asked for the one
   * thing a solver cannot do - what rooms exist, what each is for, and how they
   * connect - and never for a coordinate. Placement stays with the code that was
   * always good at it.
   */
  generateBlueprint: async (prompt, sharedOperation) => {
    const candidateConfig = get().proposedConfig ?? get().config;
    if (candidateConfig === null) return null;
    const operation = sharedOperation ?? beginDungeonOperation();
    set({ isGeneratingBlueprint: true, error: null, blueprintProblems: [] });
    try {
      const ctx = await prepareAI(operation);
      let blueprint: Blueprint | null = null;
      for await (const parsed of events(
        "/api/generate-blueprint",
        { prompt, config: candidateConfig, ...ctx },
        operation,
      )) {
        if (parsed.blueprint) {
          blueprint = parsed.blueprint as Blueprint;
          operation.commit(() => {
            set({
              proposedBlueprint: blueprint,
              blueprintProblems: (parsed.problems as BlueprintProblem[]) ?? [],
            });
          });
        }
      }
      return blueprint;
    } catch (err) {
      operationError(operation, err);
      return null;
    } finally {
      if (operation.valid()) set({ isGeneratingBlueprint: false });
      if (!sharedOperation) operation.finish();
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
  refineLayout: async (instruction) => {
    const { dungeon, blueprint: appliedBlueprint, proposedBlueprint } = get();
    if (!dungeon) return;
    const operation = beginDungeonOperation();
    const plan = proposedBlueprint ?? appliedBlueprint ?? blueprintFromDungeon(dungeon);
    set({ isRefining: true, error: null, refinement: null });
    try {
      const ctx = await prepareAI(operation);
      let image: string | null = null;
      try {
        image = await renderDungeonDataUrl(dungeon);
      } catch {
        /* text-only critique */
      }
      operation.assert();
      const sourcePrompt = ctx.conversationHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n\n");
      for await (const parsed of events(
        "/api/refine-layout",
        { blueprint: plan, dungeon, image, sourcePrompt, instruction, ...ctx },
        operation,
      )) {
        if (parsed.blueprint)
          set({
            refinement: {
              critique: String(parsed.critique ?? ""),
              blueprint: parsed.blueprint as Blueprint,
              changes: (parsed.changes as RefinementChange[]) ?? [],
              imageUsed: parsed.imageUsed === true,
            },
          });
      }
    } catch (err) {
      operationError(operation, err);
    } finally {
      operation.finish();
    }
  },

  acceptRefinement: async () => {
    const { refinement, config: appliedConfig, proposedConfig } = get();
    const config = proposedConfig ?? appliedConfig;
    if (refinement === null || config === null) return null;

    set({
      proposedBlueprint: refinement.blueprint,
      blueprintProblems: [],
      refinement: null,
    });

    // A refined plan is a different dungeon, so it gets a fresh seed rather
    // than reusing one whose placement was solved for the old room set.
    return (
      await applyGeneratedGeometry(
        { ...config, seed: Math.floor(Math.random() * 2147483647) },
        set,
        get,
      )
    ).fork;
  },

  generateDungeonFromConfig: async () => {
    const { config: appliedConfig, proposedConfig, dungeonId } = get();
    const config = proposedConfig ?? appliedConfig;
    if (config === null) return null;
    const epoch = loadEpoch;
    const result = await applyGeneratedGeometry(config, set, get);
    if (
      result.ok &&
      result.fork === null &&
      epoch === loadEpoch &&
      get().dungeonId === dungeonId &&
      useAIStore.getState().autoDescribe
    ) {
      const described = await get().describeRooms();
      if (
        described &&
        epoch === loadEpoch &&
        get().dungeonId === dungeonId &&
        !get().error
      )
        await get().describeDungeon();
    }
    return result.fork;
  },

  /**
   * A reroll never overwrites a described map. New geometry means new room ids,
   * so writing over the original would silently invalidate every description
   * already written against it — instead the reroll lands as a sibling.
   */
  rerollDungeon: async (seed?: number) => {
    const { config: appliedConfig, proposedConfig } = get();
    const config = proposedConfig ?? appliedConfig;
    if (config === null) return null;
    const newSeed = seed ?? Math.floor(Math.random() * 2147483647);
    return (
      await applyGeneratedGeometry({ ...config, seed: newSeed }, set, get)
    ).fork;
  },

  restoreRevision: async (revisionId) => {
    const { dungeonId } = get();
    if (dungeonId === null) return false;
    try {
      const result = await api.dungeons.restoreRevision(dungeonId, revisionId, {
        expectedRevision: dungeonSaves.revision(dungeonId),
        operationId: crypto.randomUUID(),
      });
      if (get().dungeonId !== dungeonId) return false;
      const record = dungeonSaves.attach(result.dungeon);
      set({
        config: record.config,
        dungeon: record.geometry,
        blueprint: record.blueprint,
        proposedConfig: null,
        proposedBlueprint: null,
        dungeonDescription: record.overview,
        roomDescriptions: new Map(record.roomNotes),
        error: null,
      });
      return true;
    } catch (err) {
      if (get().dungeonId === dungeonId)
        set({ error: err instanceof Error ? err.message : "Could not restore revision" });
      return false;
    }
  },

  /*
   * Rooms are described in batches, not one request per room.
   *
   * The per-room loop this replaces cost one model call per room, which was
   * tolerable at six rooms and ruinous once the density fix started producing
   * fifty. Batching also reads better: the model sees a group at once, so it
   * varies them against each other instead of writing each in isolation.
   */
  describeRooms: async (requestedRoomIds) => {
    const { dungeon, config } = get();
    if (!dungeon || !config) return false;
    const requested = requestedRoomIds
      ? dungeon.rooms.filter((room) => requestedRoomIds.includes(room.id))
      : dungeon.rooms;
    if (requested.length === 0) return true;
    const operation = beginDungeonOperation();
    set({ isDescribingRooms: true, error: null, missingRoomIds: [] });
    try {
      const missing = new Set<number>();
      for (let i = 0; i < requested.length; i += DESCRIBE_BATCH_SIZE) {
        const batch = requested.slice(i, i + DESCRIBE_BATCH_SIZE);
        const ctx = await prepareAI(operation);
        let streamingText = "";
        const roomName = `Rooms ${batch.map((r) => r.id).join(", ")}`;
        set({
          describeProgress: {
            current: i,
            total: requested.length,
            roomName,
            streamingText,
          },
        });
        for await (const parsed of events(
          "/api/describe-rooms",
          {
            rooms: batch,
            allRooms: dungeon.rooms,
            corridors: dungeon.corridors,
            config,
            ...ctx,
          },
          operation,
        )) {
          if (typeof parsed.text === "string") {
            streamingText += parsed.text;
            set({
              describeProgress: {
                current: i,
                total: requested.length,
                roomName,
                streamingText,
              },
            });
          }
          if (Array.isArray(parsed.descriptions))
            operation.commit(() => {
              for (const result of parsed.descriptions as Array<{
                roomId?: number;
                description?: RoomDescription;
              }>) {
                if (typeof result.roomId === "number" && result.description)
                  get().setRoomDescription(result.roomId, result.description);
              }
            });
          if (Array.isArray(parsed.missingRoomIds))
            for (const roomId of parsed.missingRoomIds)
              if (typeof roomId === "number") missing.add(roomId);
        }
      }
      if (!operation.valid()) return false;
      set({ missingRoomIds: [...missing] });
      return missing.size === 0;
    } catch (err) {
      operationError(operation, err);
      return false;
    } finally {
      operation.finish();
    }
  },

  describeRoom: async (roomId) => {
    const { dungeon, config } = get();
    const room = dungeon?.rooms.find((r) => r.id === roomId);
    if (!dungeon || !config || !room) return;
    const operation = beginDungeonOperation();
    set({
      isDescribingRooms: true,
      error: null,
      describeProgress: {
        current: 0,
        total: 1,
        roomName: `Room ${roomId}`,
        streamingText: "",
      },
    });
    try {
      const ctx = await prepareAI(operation);
      for await (const parsed of events(
        `/api/describe-room/${roomId}`,
        {
          room,
          allRooms: dungeon.rooms,
          corridors: dungeon.corridors,
          config,
          ...ctx,
        },
        operation,
      )) {
        const result = parsed.description as
          | { roomId?: number; description?: RoomDescription }
          | null
          | undefined;
        if (result && typeof result.roomId === "number" && result.description)
          operation.commit(() =>
            get().setRoomDescription(
              result.roomId!,
              result.description!,
            ),
          );
      }
    } catch (err) {
      operationError(operation, err);
    } finally {
      operation.finish();
    }
  },

  describeDungeon: async () => {
    const { dungeon, config } = get();
    if (!dungeon || !config) return;
    const operation = beginDungeonOperation();
    set({ isDescribingDungeon: true, error: null });
    try {
      const ctx = await prepareAI(operation);
      for await (const parsed of events(
        "/api/describe-dungeon",
        { rooms: dungeon.rooms, corridors: dungeon.corridors, config, ...ctx },
        operation,
      )) {
        if (parsed.description)
          operation.commit(() =>
            get().setDungeonDescription(
              parsed.description as DungeonDescription,
            ),
          );
      }
    } catch (err) {
      operationError(operation, err);
    } finally {
      operation.finish();
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
    set({
      dungeon: prev,
      _undoStack: _undoStack.slice(0, -1),
      _redoStack: nextRedo,
    });
    queueSave(dungeonId, { geometry: prev });
  },

  redoEdit: () => {
    const { dungeon, dungeonId, _undoStack, _redoStack } = get();
    if (_redoStack.length === 0 || !dungeon) return;
    const next = _redoStack[0]!;
    const nextUndo = [..._undoStack, dungeon].slice(-50);
    set({
      dungeon: next,
      _undoStack: nextUndo,
      _redoStack: _redoStack.slice(1),
    });
    queueSave(dungeonId, { geometry: next });
  },

  reset: () => {
    dungeonOperations.cancel();
    ++loadEpoch;
    set({
      config: null,
      dungeon: null,
      roomDescriptions: new Map<number, RoomDescription>(),
      dungeonDescription: null,
      _undoStack: [],
      _redoStack: [],
      ...transientDefaults,
    });
  },
}));

// Invalidate synchronously when navigation is published, before React effects
// run. A room selection inside the same owner does not cancel a batch.
if (typeof window !== "undefined") {
  subscribeNavigation(() => {
    const route = parseRoute(window.location.pathname);
    const owner = useDungeonStore.getState();
    if (
      owner.dungeonId !== null &&
      (route.view !== "dungeon" ||
        route.dungeonId !== owner.dungeonId ||
        route.campaignId !== owner.campaignId)
    ) {
      owner.closeDungeon();
    }
  });
}

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
  const candidate = useChatStore.getState().chat;
  const chat =
    candidate?.dungeonId === dungeonId && candidate?.campaignId === campaignId
      ? candidate
      : null;

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
): Promise<{ ok: boolean; fork: DungeonRecord | null }> {
  const {
    dungeonId,
    roomDescriptions,
    dungeonDescription,
    dungeon,
    blueprint: appliedBlueprint,
    proposedBlueprint,
    pendingForkOperationId,
  } = get();
  const blueprint = proposedBlueprint ?? appliedBlueprint;
  const operation = beginDungeonOperation();
  set({ isGeneratingDungeon: true, error: null });
  try {
    const ctx = await prepareAI(operation);
    const res = await fetch("/api/generate-dungeon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, blueprint, ...ctx }),
      signal: operation.signal,
    });
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
    const data = (await res.json()) as { dungeon: Dungeon };
    operation.assert();
    const existingRevision =
      dungeonId === null ? 0 : dungeonSaves.revision(dungeonId);
    const shouldFork =
      dungeonId !== null &&
      (roomDescriptions.size > 0 || dungeonDescription !== null || existingRevision > 0 || dungeon !== null);
    if (shouldFork) {
      const operationId = pendingForkOperationId ?? crypto.randomUUID();
      set({ pendingForkOperationId: operationId });
      const fork = await api.dungeons.fork(dungeonId, {
        seed: config.seed ?? null,
        config,
        geometry: data.dungeon,
        blueprint,
        expectedRevision: dungeonSaves.revision(dungeonId),
        operationId,
      });
      operation.assert();
      set({ pendingForkOperationId: null });
      return { ok: true, fork };
    }
    operation.commit(() => {
      set({
        config,
        proposedConfig: null,
        dungeon: data.dungeon,
        blueprint,
        proposedBlueprint: null,
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
    });
    return { ok: true, fork: null };
  } catch (err) {
    operationError(operation, err);
    return { ok: false, fork: null };
  } finally {
    operation.finish();
  }
}
