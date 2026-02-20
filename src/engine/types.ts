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
  description?: RoomDescription;
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

export interface Dungeon {
  grid: Cell[][];
  width: number;
  height: number;
  rooms: Room[];
  corridors: Corridor[];
  features: Feature[];
  config: DungeonConfig;
  seed: number;
}
