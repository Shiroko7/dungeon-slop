/**
 * The shapes crossing the wire between the server and the browser.
 *
 * Type-only, and it must stay that way: the browser imports this, and a single
 * runtime import here would drag `bun:sqlite` into the client bundle by way of
 * the accessor modules next door. Vite stubs that silently, so the failure is a
 * blank page rather than a build error. See `src/notes/shared.ts` for the same
 * rule applied to constants.
 */
import type { Blueprint } from "../ai/blueprint.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import type {
  Dungeon,
  DungeonDescription,
  RoomDescription,
} from "../engine/types.ts";

/** The root object. Everything else is inside exactly one of these. */
export interface Campaign {
  id: number;
  name: string;
  blurb: string;
  createdAt: number;
  updatedAt: number;
  noteCount: number;
  dungeonCount: number;
  chatCount: number;
}

export interface CampaignInput {
  name: string;
  blurb?: string;
}

/** Enough to render a dungeon in a list without loading its geometry. */
export interface DungeonSummary {
  id: number;
  revision: number;
  campaignId: number;
  /** Set when this dungeon was forked off another by a reroll. */
  parentId: number | null;
  name: string;
  seed: number | null;
  roomCount: number;
  describedCount: number;
  hasGeometry: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DungeonRecord extends DungeonSummary {
  config: DungeonConfig | null;
  geometry: Dungeon | null;
  overview: DungeonDescription | null;
  /** The floor plan this map was built from, when one was used. */
  blueprint: Blueprint | null;
  /** Authored room text, as `[roomIndex, description]` pairs. */
  roomNotes: Array<[number, RoomDescription]>;
}

export interface DungeonRevision {
  id: number;
  dungeonId: number;
  kind: "overview" | "room";
  roomIndex: number | null;
  content: DungeonDescription | RoomDescription;
  source: string;
  createdAt: number;
}

export interface DungeonInput {
  name: string;
  seed?: number | null;
  config?: DungeonConfig | null;
  geometry?: Dungeon | null;
  overview?: DungeonDescription | null;
  blueprint?: Blueprint | null;
  parentId?: number | null;
  forkOperationId?: string | null;
}

export type DungeonPatch = Partial<Omit<DungeonInput, "parentId">> & {
  roomNotes?: Array<[number, RoomDescription | null]>;
};

export interface DungeonMutation {
  expectedRevision: number;
  operationId: string;
  patch: DungeonPatch;
}

export interface ChatSummary {
  id: number;
  campaignId: number;
  /** `null` is a Loremaster thread; a number is that dungeon's Architect log. */
  dungeonId: number | null;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

/** A retrieved passage, carried alongside an answer so it can be checked. */
export interface Citation {
  chunkId: number;
  docId: number;
  filename: string;
  headingPath: string;
  snippet: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  citations: Citation[] | null;
  createdAt: number;
}

export interface ChatRecord extends ChatSummary {
  messages: ChatMessage[];
}

export interface MessageInput {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[] | null;
}
