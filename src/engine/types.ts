import type { DungeonConfig } from "../ai/schema.ts";
import type { GroundingProvenance } from "../ai/grounding-types.ts";
import type { SectorGeometry } from "./sector.ts";

/** Shape name for a room that is a slice of a ring; its geometry is `Room.sector`. */
export const SECTOR_SHAPE = "Sector";

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
  /** User-protected room requirement from the editable blueprint. */
  locked?: boolean;
  wing?: string;
  notes?: string;
  /** What bars the way in or out, taken from the blueprint's edges. */
  gating?: string[];
  /** Door preferences requested by blueprint edges; geometry may report them as unmet. */
  doorPreferences?: string[];
  /** Radial plans only: 0 is the centre, 1 the first ring around it. */
  ring?: number;
  /** Radial plans only: order around the ring, clockwise from twelve o'clock. */
  sector?: number;
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
  /** Present only on "Sector" rooms: the slice of a ring the room occupies. The
   * bounding box above is derived from it, and centerX/centerY is a cell inside
   * the slice rather than the middle of the box. */
  sector?: SectorGeometry;
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
  /** Note passages used for this generated description, if any. */
  grounding?: GroundingProvenance;
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
  /** Note passages used for this generated overview, if any. */
  grounding?: GroundingProvenance;
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
  /** Blueprint requirements checked against the delivered geometry. */
  constraints?: {
    requestedConnections: number;
    deliveredConnections: number;
    unmetConnections: Array<{ from: string; to: string }>;
    reachableRooms: number;
    unreachableRooms: string[];
    requestedEntrances: number;
    deliveredEntrances: number;
    unmetRequirements: string[];
  };
}

/** A seamless texture from the asset library (`bun run assets`) laid over floor. */
export interface TextureRef {
  /** Asset id in the library, e.g. "floor-sunken-temple-1a2b3c". */
  asset: string;
  /** How many grid cells one repeat of the texture spans (default 4). */
  cells?: number;
  /** 0..1: darken the texture by this much (0 = as generated). */
  shade?: number;
  /**
   * Draw the image once, scaled to cover the room's bounds, instead of
   * repeating it (a round mosaic for a round room). Room overrides only.
   */
  fit?: boolean;
  /** Degrees clockwise. */
  rotation?: number;
  /**
   * "radial" (rooms only): the tile's rows are bent into rings around the
   * room's circle and its columns become joints running out from the centre,
   * so courses follow curved walls. Default "grid".
   */
  layout?: "grid" | "radial";
  /** Radial only, 0..1: shift along the rings, so neighbouring rooms' joints don't line up. */
  stagger?: number;
  /**
   * A set of edge-matched variants of the tile (asset ids, the tile itself
   * included). Each tile position shows one, picked at random but stable, so
   * large areas stop looking repetitive. Not used with fit.
   */
  variants?: string[];
  /** Changes which variant lands where ("shuffle"). */
  variantSeed?: number;
  /**
   * A second texture laid over this one, at its own scale, to bring in another
   * texture's look (stains, wear, colour) without its pattern lining up with
   * the base's stones.
   */
  blend?: TextureBlend;
}

export interface TextureBlend {
  asset: string;
  /** Grid cells per repeat; make it much larger than the base's. Default 24. */
  cells?: number;
  /** 0..1, default 0.5. */
  amount?: number;
  /** How it combines with the base. Default "soft-light". */
  mode?: "soft-light" | "overlay" | "multiply" | "color" | "normal";
}

/** A prop, decal or token from the asset library placed on the map (the Stamp tool). */
export interface MapObject {
  id: string;
  asset: string;
  /** Centre, in grid cells (fractional). */
  x: number;
  y: number;
  /** Width in grid cells; height follows the image's aspect ratio. */
  size: number;
  /** Degrees clockwise. */
  rotation?: number;
  /** 0..1, default 1. */
  opacity?: number;
  /** Soft drop shadow under the object. */
  shadow?: boolean;
  flipX?: boolean;
}

/** Map art chosen for a dungeon. Purely visual; generation never reads it. */
export interface DungeonStyle {
  /** Objects on the map, drawn in order (later on top). */
  objects?: MapObject[];
  /** Floor of every room and corridor. */
  floor?: TextureRef;
  /** Everything outside the floor (the paper around and between rooms), e.g. water. */
  background?: TextureRef;
  /** Per-room floor overrides, keyed by room id. */
  rooms?: Record<string, { floor?: TextureRef }>;
}

export interface Dungeon {
  /** Optional map art; see DungeonStyle. */
  style?: DungeonStyle;
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
