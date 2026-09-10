import type { Room } from "../engine/types.ts";
import { CellType, PENTAGON_W, PENTAGON_H } from "../engine/types.ts";
import type { Cell } from "../engine/types.ts";

export interface Point {
  x: number;
  y: number;
}

export interface RoomGeometry {
  type: "ellipse" | "polygon" | "path" | "rect";
  centerX: number;
  centerY: number;
  // For ellipse
  radiusX?: number;
  radiusY?: number;
  // For polygon
  vertices?: Point[];
  // For path (cross shape): the bars whose union makes the shape. Kept as plain
  // rects rather than a Path2D so describing a room needs no canvas.
  rects?: Array<{ x: number; y: number; width: number; height: number }>;
  // Bounding box
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * The two bars of a Cross room, in whole grid cells.
 *
 * Shared with carveCross so the drawn shape lands on exactly the cells the room
 * owns: centring the bars on the room's midpoint instead rounds differently for
 * odd spans, leaving a half-cell of floor outside the outline.
 */
export function crossBars(room: Room): { hy: number; hh: number; vx: number; vw: number } {
  const bar = Math.max(2, Math.floor(Math.min(room.width, room.height) / 3));
  return {
    hy: room.y + Math.floor((room.height - bar) / 2),
    hh: bar,
    vx: room.x + Math.floor((room.width - bar) / 2),
    vw: bar,
  };
}

/** The square carveSquare actually fills: the largest one centred in the bounds. */
export function squareBounds(room: Room): { x: number; y: number; side: number } {
  const side = Math.min(room.width, room.height);
  return {
    x: room.x + Math.floor((room.width - side) / 2),
    y: room.y + Math.floor((room.height - side) / 2),
    side,
  };
}

// The same room's geometry is asked for over and over — every outline build,
// hover overlay and shape test — so it is built once per room and cell size.
const geometryCache = new WeakMap<Room, Map<number, RoomGeometry>>();

export function getRoomGeometry(room: Room, cellSize: number): RoomGeometry {
  let bySize = geometryCache.get(room);
  if (bySize === undefined) {
    bySize = new Map();
    geometryCache.set(room, bySize);
  }
  const hit = bySize.get(cellSize);
  if (hit !== undefined) return hit;
  const built = buildRoomGeometry(room, cellSize);
  bySize.set(cellSize, built);
  return built;
}

function buildRoomGeometry(room: Room, cellSize: number): RoomGeometry {
  const boundsX = room.x * cellSize;
  const boundsY = room.y * cellSize;
  const boundsWidth = room.width * cellSize;
  const boundsHeight = room.height * cellSize;
  const centerX = boundsX + boundsWidth / 2;
  const centerY = boundsY + boundsHeight / 2;

  const bounds = {
    x: boundsX,
    y: boundsY,
    width: boundsWidth,
    height: boundsHeight,
  };

  switch (room.shape) {
    case "Circular": {
      const r = Math.min(boundsWidth, boundsHeight) / 2;
      return {
        type: "ellipse",
        centerX,
        centerY,
        radiusX: r,
        radiusY: r,
        bounds,
      };
    }

    case "Diamond": {
      const r = Math.min(boundsWidth, boundsHeight) / 2;
      return {
        type: "polygon",
        centerX,
        centerY,
        vertices: [
          { x: centerX, y: centerY - r }, // top
          { x: centerX + r, y: centerY }, // right
          { x: centerX, y: centerY + r }, // bottom
          { x: centerX - r, y: centerY }, // left
        ],
        bounds,
      };
    }

    case "Hexagonal": {
      // Pointy-top hexagon: natural ratio width = √3 * r, height = 2 * r
      const r = Math.min(boundsWidth / Math.sqrt(3), boundsHeight / 2);
      const hw = (r * Math.sqrt(3)) / 2;
      return {
        type: "polygon",
        centerX,
        centerY,
        vertices: [
          { x: centerX, y: centerY - r },          // top
          { x: centerX + hw, y: centerY - r / 2 }, // top-right
          { x: centerX + hw, y: centerY + r / 2 }, // bottom-right
          { x: centerX, y: centerY + r },           // bottom
          { x: centerX - hw, y: centerY + r / 2 }, // bottom-left
          { x: centerX - hw, y: centerY - r / 2 }, // top-left
        ],
        bounds,
      };
    }

    case "Pentagonal": {
      // Pentagon with pointy top; see PENTAGON_W/PENTAGON_H for the ratios.
      // A pentagon's centroid is not the middle of its own bounding box, so it
      // has to be seated by its extents — centring it on the room's midpoint
      // instead pushes the apex a twentieth of the height out past the top edge,
      // over whatever the layout put there.
      const r = Math.min(boundsWidth / PENTAGON_W, boundsHeight / PENTAGON_H);
      const seatedY = boundsY + (boundsHeight - PENTAGON_H * r) / 2 + r;
      const vertices: Point[] = [];
      for (let i = 0; i < 5; i++) {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5; // start at the apex
        vertices.push({
          x: centerX + r * Math.cos(angle),
          y: seatedY + r * Math.sin(angle),
        });
      }
      return {
        type: "polygon",
        centerX,
        centerY: seatedY,
        vertices,
        bounds,
      };
    }

    case "Cross": {
      // Cross is the union of a horizontal and a vertical bar, snapped to the
      // same cells carveCross fills.
      const bars = crossBars(room);
      return {
        type: "path",
        centerX,
        centerY,
        rects: [
          { x: boundsX, y: bars.hy * cellSize, width: boundsWidth, height: bars.hh * cellSize },
          { x: bars.vx * cellSize, y: boundsY, width: bars.vw * cellSize, height: boundsHeight },
        ],
        bounds,
      };
    }

    case "Square": {
      // carveSquare fills the largest square centred in the bounds, not the
      // bounds themselves — draw that, or an oblong room shows floor it has not
      // got along two of its edges.
      const sq = squareBounds(room);
      const sqBounds = {
        x: sq.x * cellSize,
        y: sq.y * cellSize,
        width: sq.side * cellSize,
        height: sq.side * cellSize,
      };
      return {
        type: "rect",
        centerX: sqBounds.x + sqBounds.width / 2,
        centerY: sqBounds.y + sqBounds.height / 2,
        bounds: sqBounds,
      };
    }

    case "Rectangular":
    default:
      return {
        type: "rect",
        centerX,
        centerY,
        bounds,
      };
  }
}

export function createRoomPath(geometry: RoomGeometry): Path2D {
  const path = new Path2D();

  switch (geometry.type) {
    case "ellipse":
      if (geometry.radiusX && geometry.radiusY) {
        path.ellipse(
          geometry.centerX,
          geometry.centerY,
          geometry.radiusX,
          geometry.radiusY,
          0,
          0,
          2 * Math.PI
        );
      }
      break;

    case "polygon":
      if (geometry.vertices && geometry.vertices.length > 0) {
        path.moveTo(geometry.vertices[0]!.x, geometry.vertices[0]!.y);
        for (let i = 1; i < geometry.vertices.length; i++) {
          path.lineTo(geometry.vertices[i]!.x, geometry.vertices[i]!.y);
        }
        path.closePath();
      }
      break;

    case "path":
      for (const r of geometry.rects ?? []) path.rect(r.x, r.y, r.width, r.height);
      break;

    case "rect":
      path.rect(
        geometry.bounds.x,
        geometry.bounds.y,
        geometry.bounds.width,
        geometry.bounds.height
      );
      break;
  }

  return path;
}

export function isShapedRoom(shape: string): boolean {
  return ["Circular", "Diamond", "Hexagonal", "Pentagonal"].includes(shape);
}

/**
 * Is a point inside the room as the map actually draws it?
 *
 * Not the same question as which cells the room owns. Shape carving keeps every
 * cell the shape so much as clips, so a circular or hexagonal room owns a ring
 * of cells lying outside the outline it is drawn with. Anything reasoning about
 * what the reader can see — where the paper starts, where a mark may go — has
 * to ask the geometry, not the grid.
 *
 * Coordinates are in the same units as `cellSize` (pass 1 to work in grid space).
 */
export function pointInRoomShape(room: Room, px: number, py: number, cellSize: number): boolean {
  const geo = getRoomGeometry(room, cellSize);
  const { x, y, width: w, height: h } = geo.bounds;
  if (px < x || px > x + w || py < y || py > y + h) return false;

  switch (geo.type) {
    case "ellipse": {
      const rx = geo.radiusX ?? 0;
      const ry = geo.radiusY ?? 0;
      if (rx <= 0 || ry <= 0) return false;
      const dx = (px - geo.centerX) / rx;
      const dy = (py - geo.centerY) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case "polygon": {
      // Every polygon shape here is convex and wound clockwise in screen space.
      const verts = geo.vertices ?? [];
      if (verts.length < 3) return false;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i]!;
        const b = verts[(i + 1) % verts.length]!;
        if ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) < 0) return false;
      }
      return true;
    }
    case "path":
      // Cross: the union of a horizontal and a vertical bar.
      return (geo.rects ?? []).some(
        (r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height,
      );
    case "rect":
    default:
      return true; // already inside the bounds
  }
}

export interface CorridorEntry {
  midX: number; // pixel X of the shared edge midpoint
  midY: number; // pixel Y
}

const WALKABLE_TYPES = new Set([
  CellType.Floor,
  CellType.Corridor,
  CellType.Door,
  CellType.SecretDoor,
  CellType.StairsUp,
  CellType.StairsDown,
]);

export function findCorridorEntries(
  room: Room,
  grid: Cell[][],
  cellSize: number
): CorridorEntry[] {
  const entries: CorridorEntry[] = [];

  for (let y = room.y; y < room.y + room.height; y++) {
    for (let x = room.x; x < room.x + room.width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || cell.roomId !== room.id) continue;

      const neighbors: Array<[number, number, "n" | "s" | "e" | "w"]> = [
        [x, y - 1, "n"],
        [x, y + 1, "s"],
        [x + 1, y, "e"],
        [x - 1, y, "w"],
      ];
      for (const [nx, ny, dir] of neighbors) {
        const nb = grid[ny]?.[nx];
        if (!nb || !WALKABLE_TYPES.has(nb.type) || nb.roomId === room.id) continue;
        // This edge is a corridor/door entry — record its pixel midpoint
        const px = x * cellSize;
        const py = y * cellSize;
        switch (dir) {
          case "n":
            entries.push({ midX: px + cellSize / 2, midY: py });
            break;
          case "s":
            entries.push({ midX: px + cellSize / 2, midY: py + cellSize });
            break;
          case "e":
            entries.push({ midX: px + cellSize, midY: py + cellSize / 2 });
            break;
          case "w":
            entries.push({ midX: px, midY: py + cellSize / 2 });
            break;
        }
      }
    }
  }

  // Deduplicate (two cells sharing the same corridor may record the same midpoint)
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.midX},${e.midY}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function crossOutlineVertices(
  room: Room,
  cellSize: number
): Array<{ x: number; y: number }> {
  const boundsX = room.x * cellSize;
  const boundsY = room.y * cellSize;
  const boundsWidth = room.width * cellSize;
  const boundsHeight = room.height * cellSize;

  const bars = crossBars(room);
  const hH = bars.hh * cellSize;
  const vW = bars.vw * cellSize;
  const hY = bars.hy * cellSize;
  const vX = bars.vx * cellSize;
  const bR = boundsX + boundsWidth;
  const bB = boundsY + boundsHeight;

  return [
    { x: vX, y: boundsY }, // 0 top-left of v-bar
    { x: vX + vW, y: boundsY }, // 1 top-right of v-bar
    { x: vX + vW, y: hY }, // 2 inner corner TR
    { x: bR, y: hY }, // 3 h-bar top-right
    { x: bR, y: hY + hH }, // 4 h-bar bottom-right
    { x: vX + vW, y: hY + hH }, // 5 inner corner BR
    { x: vX + vW, y: bB }, // 6 bottom-right of v-bar
    { x: vX, y: bB }, // 7 bottom-left of v-bar
    { x: vX, y: hY + hH }, // 8 inner corner BL
    { x: boundsX, y: hY + hH }, // 9 h-bar bottom-left
    { x: boundsX, y: hY }, // 10 h-bar top-left
    { x: vX, y: hY }, // 11 inner corner TL
  ];
}
