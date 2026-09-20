import type { DungeonConfig } from "../ai/schema.ts";

export enum CellType {
  Empty = 0,
  Floor = 1,
  Wall = 2,
  Corridor = 3,
  Door = 4,
  SecretDoor = 5,
  StairsUp = 6,
  StairsDown = 7,
}

export enum FeatureType {
  Door = "door",
  SecretDoor = "secret_door",
  LockedDoor = "locked_door",
  Portcullis = "portcullis",
  Archway = "archway",
  TrappedDoor = "trapped_door",
  Trap = "trap",
  Treasure = "treasure",
  StairsUp = "stairs_up",
  StairsDown = "stairs_down",
}

/**
 * What a room is FOR. Geometry alone cannot say, and without it the narrator has
 * to invent a progression the map does not actually have.
 */
export type RoomRole =
  | "entrance"
  | "hub"
  | "gauntlet"
  | "chokepoint"
  | "boss"
  | "vault"
  | "junction"
  | "chamber";

/** What the blueprint said this room was for, carried through to the narrator. */
export interface RoomPlan {
  key: string;
  name: string;
  wing?: string;
  notes?: string;
  /** What bars the way in or out, taken from the blueprint's edges. */
  gating?: string[];
}

export interface Cell {
  type: CellType;
  roomId: number | null;
  corridorId: number | null;
  featureId: number | null;
}

export interface Room {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  shape: string;
  connections: number[];
  features: Feature[];
  /** Cell footprint created after a manual edit. Procedural rooms keep their
   * smooth shape until an edit actually changes their boundary. */
  footprint?: Array<{ x: number; y: number }>;
  description?: RoomDescription;
  /** Assigned by the layout-rules pass, not by the geometry generators. */
  role?: RoomRole;
  /** Depth in rooms from the entrance; null if unreachable. */
  tier?: number | null;
  /** On the entrance-to-boss route the party cannot skip. */
  onCriticalPath?: boolean;
  /** Present only on blueprint-built dungeons. */
  plan?: RoomPlan;
}

// A pointy-top regular pentagon of circumradius r spans 2·sin(72°)·r across and
// (1 + cos(36°))·r down. Rounded to 1.902/1.809 the width came out ~0.0003 cells
// too large, which is enough to push a vertex outside the room's own rectangle.
export const PENTAGON_W = 2 * Math.sin((2 * Math.PI) / 5);
export const PENTAGON_H = 1 + Math.cos(Math.PI / 5);

/**
 * Is this room an organic blob rather than a shape with a formula?
 *
 * Cave rooms are drawn cell by cell; everything else is drawn as a smooth
 * outline. Case-insensitive because the cellular generator has been writing
 * "cave" while every reader compared against "Cave" — which silently drew every
 * organic room as a filled rectangle over its bounding box.
 */
export function isCaveShape(shape: string): boolean {
  return shape.toLowerCase() === "cave";
}

export interface Corridor {
  id: number;
  roomA: number;
  roomB: number;
  path: Array<{ x: number; y: number }>;
  width: number;
}

export interface Feature {
  id: number;
  type: FeatureType;
  x: number;
  y: number;
  metadata?: Record<string, unknown>;
}

export interface RoomEntry {
  direction: string;
  doorType: string;
  leadsTo: string;
  trap?: string;
}

export interface RoomDescription {
  name: string;
  /** @deprecated Use `features` instead — kept for backward compat with old localStorage data */
  description?: string;
  entries?: RoomEntry[];
  features?: string;
  monsters?: string[];
  treasure?: string[];
  hiddenTreasure?: string;
  traps?: string[];
  tricks?: string[];
  notes?: string;
  empty?: boolean;
}

export interface CorridorFeature {
  label: string;
  corridorId: number;
  description: string;
}

export interface DungeonDescription {
  history: string;
  size?: string;
  walls?: string;
  floor?: string;
  temperature?: string;
  illumination?: string;
  corridorFeatures: CorridorFeature[];
  wanderingMonsters: string[];
}

/**
 * What the solver was asked for versus what it could actually build. Surfaced
 * rather than swallowed: a config asking for 32 rooms and getting 6 used to look
 * identical to one that got what it wanted.
 */
export interface LayoutReport {
  requestedRooms: number;
  deliveredRooms: number;
  /** Ceiling imposed by room size against grid size. */
  capacityRooms: number;
  junctionsAdded: number;
  longestCorridorCells: number;
  hasLoop: boolean;
}

export interface Dungeon {
  grid: Cell[][];
  width: number;
  height: number;
  rooms: Room[];
  corridors: Corridor[];
  features: Feature[];
  config: DungeonConfig;
  seed: number;
  report?: LayoutReport;
  /** Derived warnings produced by the editor when authored structure is stale. */
  editStatus?: {
    narrativeStale: boolean;
    planStale: boolean;
    disconnectedRoomIds: number[];
  };
}
