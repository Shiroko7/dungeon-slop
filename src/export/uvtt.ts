/**
 * Universal VTT (`.dd2vtt` / `.uvtt`) export, without the image.
 *
 * Universal VTT is the format Dungeondraft popularised and most virtual
 * tabletops import: a map image, wall segments for line of sight and doors as
 * "portals", all in grid units. This module builds everything except the image
 * (which needs a browser canvas, see vtt-export.ts), so the server can hand a
 * map's geometry straight to a VTT.
 *
 * Fields other tools do not know are namespaced: each portal carries `x_kind`,
 * and the whole map carries `x_slop` with the floor mask, per-cell elevation and
 * room labels. Readers that do not know them ignore them.
 */
import type { Dungeon } from "../engine/types.ts";
import { CellType, FeatureType } from "../engine/types.ts";

export interface UVTTPoint {
  x: number;
  y: number;
}

/** What stands in a doorway. "portcullis" blocks movement but not sight. */
export type DoorKind = "door" | "locked" | "secret" | "trapped" | "portcullis";

export interface UVTTPortal {
  position: UVTTPoint;
  /** The two ends of the door line, in grid units. */
  bounds: [UVTTPoint, UVTTPoint];
  rotation: number;
  closed: boolean;
  freestanding: boolean;
  x_kind: DoorKind;
}

export interface SlopExtension {
  version: 1;
  generator: "dungeon-slop";
  seed: number;
  /**
   * One string per row, one character per cell: "." walkable floor, "#" solid
   * (wall or nothing). Walls in `line_of_sight` lie exactly on the edges
   * between the two.
   */
  floor: string[];
  /**
   * Height of a cell's floor above the map's base, in grid units (one unit is
   * one square, 5 ft). Sparse: "x,y" -> height, cells not listed are at 0.
   */
  elevation: Record<string, number>;
  /** How tall walls stand, in grid units. */
  wallHeight: number;
  rooms: Array<{ id: number; name: string; x: number; y: number }>;
}

export interface UVTTMap {
  format: number;
  resolution: {
    map_origin: UVTTPoint;
    map_size: UVTTPoint;
    pixels_per_grid: number;
  };
  line_of_sight: UVTTPoint[][];
  objects_line_of_sight: UVTTPoint[][];
  portals: UVTTPortal[];
  environment: { baked_lighting: boolean; ambient_light: string };
  lights: unknown[];
  /** Base64 PNG, or "" when the map is exported without art. */
  image: string;
  x_slop: SlopExtension;
}

export const DEFAULT_WALL_HEIGHT = 2;

const DOOR_KINDS: Partial<Record<FeatureType, DoorKind>> = {
  [FeatureType.Door]: "door",
  [FeatureType.LockedDoor]: "locked",
  [FeatureType.SecretDoor]: "secret",
  [FeatureType.TrappedDoor]: "trapped",
  [FeatureType.Portcullis]: "portcullis",
  // Archways are openings with nothing in them: no portal.
};

function cellType(dungeon: Dungeon, x: number, y: number): CellType {
  return dungeon.grid[y]?.[x]?.type ?? CellType.Empty;
}

export function isSolid(type: CellType): boolean {
  return type === CellType.Wall || type === CellType.Empty;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Join touching segments that lie on one line. */
function mergeRuns(segments: Segment[], horizontal: boolean): Segment[] {
  const lines = new Map<number, Segment[]>();
  for (const s of segments) {
    const key = horizontal ? s.y1 : s.x1;
    const line = lines.get(key);
    if (line) line.push(s);
    else lines.set(key, [s]);
  }
  const merged: Segment[] = [];
  for (const line of lines.values()) {
    line.sort((a, b) => (horizontal ? a.x1 - b.x1 : a.y1 - b.y1));
    let current = { ...line[0]! };
    for (const next of line.slice(1)) {
      const touches = horizontal ? next.x1 === current.x2 : next.y1 === current.y2;
      if (touches) {
        if (horizontal) current.x2 = next.x2;
        else current.y2 = next.y2;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }
  return merged;
}

/**
 * Every edge between a solid cell and a walkable one, as merged straight
 * segments in grid units. Door cells are walkable: their sides are wall, and
 * the door itself is a portal across the cell.
 */
export function wallSegments(dungeon: Dungeon): UVTTPoint[][] {
  const horizontal: Segment[] = [];
  const vertical: Segment[] = [];
  for (let y = 0; y <= dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      if (isSolid(cellType(dungeon, x, y - 1)) !== isSolid(cellType(dungeon, x, y))) {
        horizontal.push({ x1: x, y1: y, x2: x + 1, y2: y });
      }
    }
  }
  for (let x = 0; x <= dungeon.width; x++) {
    for (let y = 0; y < dungeon.height; y++) {
      if (isSolid(cellType(dungeon, x - 1, y)) !== isSolid(cellType(dungeon, x, y))) {
        vertical.push({ x1: x, y1: y, x2: x, y2: y + 1 });
      }
    }
  }
  return [...mergeRuns(horizontal, true), ...mergeRuns(vertical, false)].map((s) => [
    { x: s.x1, y: s.y1 },
    { x: s.x2, y: s.y2 },
  ]);
}

/**
 * One portal per door feature. A wide doorway (several side-by-side cells
 * sharing one feature) is one portal spanning all of them. The door line runs
 * across the passage through the middle of its cells.
 */
export function doorPortals(dungeon: Dungeon): UVTTPortal[] {
  const cellsOf = new Map<number, UVTTPoint[]>();
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const id = dungeon.grid[y]![x]!.featureId;
      if (id === null) continue;
      const list = cellsOf.get(id);
      if (list) list.push({ x, y });
      else cellsOf.set(id, [{ x, y }]);
    }
  }

  const portals: UVTTPortal[] = [];
  for (const feature of dungeon.features) {
    const kind = DOOR_KINDS[feature.type];
    if (!kind) continue;
    const cells = cellsOf.get(feature.id) ?? [{ x: feature.x, y: feature.y }];
    portals.push(portalFor(dungeon, cells, kind));
  }
  return portals;
}

function portalFor(dungeon: Dungeon, cells: UVTTPoint[], kind: DoorKind): UVTTPortal {
  const first = cells[0]!;
  // Walkable left and right: the passage runs east-west, so the door line runs north-south.
  const passageEastWest =
    !isSolid(cellType(dungeon, first.x - 1, first.y)) && !isSolid(cellType(dungeon, first.x + 1, first.y));
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs) + 1;
  const minY = Math.min(...ys), maxY = Math.max(...ys) + 1;
  const bounds: [UVTTPoint, UVTTPoint] = passageEastWest
    ? [{ x: (minX + maxX) / 2, y: minY }, { x: (minX + maxX) / 2, y: maxY }]
    : [{ x: minX, y: (minY + maxY) / 2 }, { x: maxX, y: (minY + maxY) / 2 }];
  return {
    position: { x: (bounds[0].x + bounds[1].x) / 2, y: (bounds[0].y + bounds[1].y) / 2 },
    bounds,
    rotation: passageEastWest ? Math.PI / 2 : 0,
    // Every door starts shut; the table decides when it opens.
    closed: true,
    freestanding: false,
    x_kind: kind,
  };
}

export function floorRows(dungeon: Dungeon): string[] {
  const rows: string[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    let row = "";
    for (let x = 0; x < dungeon.width; x++) row += isSolid(cellType(dungeon, x, y)) ? "#" : ".";
    rows.push(row);
  }
  return rows;
}

export interface UVTTOptions {
  /** Base64 PNG of the rendered map, without the data: prefix. */
  image?: string;
  pixelsPerGrid?: number;
}

export function dungeonToUVTT(dungeon: Dungeon, options: UVTTOptions = {}): UVTTMap {
  return {
    format: 0.3,
    resolution: {
      map_origin: { x: 0, y: 0 },
      map_size: { x: dungeon.width, y: dungeon.height },
      pixels_per_grid: options.pixelsPerGrid ?? 140,
    },
    line_of_sight: wallSegments(dungeon),
    objects_line_of_sight: [],
    portals: doorPortals(dungeon),
    environment: { baked_lighting: false, ambient_light: "ffffffff" },
    lights: [],
    image: options.image ?? "",
    x_slop: {
      version: 1,
      generator: "dungeon-slop",
      seed: dungeon.seed,
      floor: floorRows(dungeon),
      // The generator builds flat levels; the format carries height for the table to edit.
      elevation: {},
      wallHeight: DEFAULT_WALL_HEIGHT,
      rooms: dungeon.rooms.map((room) => ({
        id: room.id,
        name: room.description?.name || room.plan?.name || `Room ${room.id}`,
        x: room.centerX + 0.5,
        y: room.centerY + 0.5,
      })),
    },
  };
}
